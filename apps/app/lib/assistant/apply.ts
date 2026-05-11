import 'server-only';
import { and, eq, sql as sqlTag } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import {
  draftSection,
  embedText,
  EMBEDDING_MODEL,
  meter,
  meterEmbedding,
  MODELS,
} from '@procur/ai';
import { enrichOrgsBatch } from '@procur/apollo';
import {
  alertProfiles,
  auditLog,
  db,
  knownEntities,
  opportunities,
  proposals,
  pursuits,
  pursuitTasks,
  type NewAlertProfile,
  type NewKnownEntity,
  type NewPursuit,
  type NewPursuitTask,
} from '@procur/db';
import type { AssistantContext } from '@procur/ai';
import { getActivePursuitCount } from '../capture-queries';
import { fireExtractRequirements } from '../trigger-extract-requirements';
import { semanticSearchLibrary } from '../library-queries';
import { semanticSearchPastPerformance } from '../past-performance-queries';
import { FREE_TIER_ACTIVE_PURSUIT_CAP } from '../plan-limits';

/**
 * Result of an apply. ok=true with result (entity id + redirectTo), or
 * ok=false with a user-visible error code.
 */
export type ApplyResult =
  | { ok: true; result: Record<string, unknown> }
  | { ok: false; error: string; message?: string };

type ApplyContext = AssistantContext & { threadId: string };

type ApplyHandler = (ctx: ApplyContext, payload: unknown) => Promise<ApplyResult>;

// -- Handlers ----------------------------------------------------------------

const createPursuitSchema = z.object({
  opportunityId: z.string(),
  notes: z.string().nullable().optional(),
});

const createPursuit: ApplyHandler = async (ctx, rawPayload) => {
  const payload = createPursuitSchema.parse(rawPayload);

  const opp = await db.query.opportunities.findFirst({
    where: eq(opportunities.id, payload.opportunityId),
    columns: { id: true },
  });
  if (!opp) return { ok: false, error: 'opportunity_not_found' };

  const existing = await db.query.pursuits.findFirst({
    where: and(
      eq(pursuits.companyId, ctx.companyId),
      eq(pursuits.opportunityId, payload.opportunityId),
    ),
  });
  if (existing) {
    return {
      ok: true,
      result: { pursuitId: existing.id, redirectTo: `/capture/pursuits/${existing.id}` },
    };
  }

  // Free-tier cap parity with createPursuitAction.
  const company = await db.query.companies.findFirst({
    where: (c, { eq: _eq }) => _eq(c.id, ctx.companyId),
    columns: { planTier: true },
  });
  if (company?.planTier === 'free') {
    const active = await getActivePursuitCount(ctx.companyId);
    if (active >= FREE_TIER_ACTIVE_PURSUIT_CAP) {
      return { ok: false, error: 'free_tier_pursuit_cap' };
    }
  }

  const row: NewPursuit = {
    companyId: ctx.companyId,
    opportunityId: payload.opportunityId,
    stage: 'identification',
    assignedUserId: ctx.userId,
    notes: payload.notes ?? null,
  };
  const [created] = await db.insert(pursuits).values(row).returning({ id: pursuits.id });
  if (!created) return { ok: false, error: 'insert_failed' };

  // Defer expensive Sonnet requirement-extraction until tracking time.
  // Idempotent — re-runs across users / tenants are no-ops.
  await fireExtractRequirements(payload.opportunityId);

  revalidatePath('/capture');
  revalidatePath('/capture/pipeline');
  return {
    ok: true,
    result: { pursuitId: created.id, redirectTo: `/capture/pursuits/${created.id}` },
  };
};

const advanceStageSchema = z.object({
  pursuitId: z.string(),
  stage: z.enum([
    'identification',
    'qualification',
    'capture_planning',
    'proposal_development',
    'submitted',
    'awarded',
    'lost',
  ]),
});

const advanceStage: ApplyHandler = async (ctx, rawPayload) => {
  const payload = advanceStageSchema.parse(rawPayload);
  const existing = await db.query.pursuits.findFirst({
    where: and(eq(pursuits.id, payload.pursuitId), eq(pursuits.companyId, ctx.companyId)),
  });
  if (!existing) return { ok: false, error: 'pursuit_not_found' };

  const now = new Date();
  const updates: Record<string, unknown> = { stage: payload.stage, updatedAt: now };
  if (payload.stage === 'submitted') updates.submittedAt = now;
  if (payload.stage === 'awarded') updates.wonAt = now;
  if (payload.stage === 'lost') updates.lostAt = now;

  await db
    .update(pursuits)
    .set(updates)
    .where(and(eq(pursuits.id, payload.pursuitId), eq(pursuits.companyId, ctx.companyId)));

  revalidatePath('/capture');
  revalidatePath('/capture/pipeline');
  revalidatePath(`/capture/pursuits/${payload.pursuitId}`);
  return {
    ok: true,
    result: {
      pursuitId: payload.pursuitId,
      fromStage: existing.stage,
      toStage: payload.stage,
      redirectTo: `/capture/pursuits/${payload.pursuitId}`,
    },
  };
};

const createTaskSchema = z.object({
  pursuitId: z.string(),
  title: z.string(),
  description: z.string().nullable().optional(),
  dueDate: z.string().nullable().optional(),
  priority: z.enum(['low', 'medium', 'high', 'urgent']).optional(),
  category: z.enum(['research', 'outreach', 'drafting', 'review', 'submission']).optional(),
});

const createTask: ApplyHandler = async (ctx, rawPayload) => {
  const payload = createTaskSchema.parse(rawPayload);

  const pursuit = await db.query.pursuits.findFirst({
    where: and(eq(pursuits.id, payload.pursuitId), eq(pursuits.companyId, ctx.companyId)),
    columns: { id: true },
  });
  if (!pursuit) return { ok: false, error: 'pursuit_not_found' };

  const row: NewPursuitTask = {
    pursuitId: payload.pursuitId,
    title: payload.title,
    description: payload.description ?? null,
    dueDate: payload.dueDate ?? null,
    priority: payload.priority ?? 'medium',
    category: payload.category ?? 'research',
    assignedUserId: ctx.userId,
  };
  const [created] = await db
    .insert(pursuitTasks)
    .values(row)
    .returning({ id: pursuitTasks.id });
  if (!created) return { ok: false, error: 'insert_failed' };

  revalidatePath(`/capture/pursuits/${payload.pursuitId}`);
  revalidatePath('/capture/tasks');
  return {
    ok: true,
    result: {
      taskId: created.id,
      pursuitId: payload.pursuitId,
      redirectTo: `/capture/pursuits/${payload.pursuitId}`,
    },
  };
};

const draftSectionSchema = z.object({
  pursuitId: z.string(),
  sectionId: z.string(),
  userInstruction: z.string().nullable().optional(),
});

type OutlineEntry = {
  id: string;
  number: string;
  title: string;
  description: string;
  evaluationCriteria: string[];
  mandatoryContent: string[];
  pageLimit?: number;
};

type SectionStatus = 'empty' | 'ai_drafted' | 'in_review' | 'finalized';
type SectionEntry = {
  id: string;
  outlineId: string;
  title: string;
  content: string;
  status: SectionStatus;
  wordCount: number;
  lastEditedAt: string;
};

const draftProposalSection: ApplyHandler = async (ctx, rawPayload) => {
  const payload = draftSectionSchema.parse(rawPayload);

  const [row] = await db
    .select({
      proposalId: proposals.id,
      outline: proposals.outline,
      sections: proposals.sections,
      oppTitle: opportunities.title,
      oppDescription: opportunities.description,
      oppReferenceNumber: opportunities.referenceNumber,
      companyPlan: pursuits.companyId,
    })
    .from(proposals)
    .innerJoin(pursuits, eq(pursuits.id, proposals.pursuitId))
    .innerJoin(opportunities, eq(opportunities.id, pursuits.opportunityId))
    .where(and(eq(proposals.pursuitId, payload.pursuitId), eq(pursuits.companyId, ctx.companyId)))
    .limit(1);
  if (!row) return { ok: false, error: 'proposal_not_found' };

  const sections = (row.sections as SectionEntry[] | null) ?? [];
  const section = sections.find((s) => s.id === payload.sectionId);
  if (!section) return { ok: false, error: 'section_not_found' };
  const outline = (row.outline as OutlineEntry[] | null) ?? [];
  const outlineEntry = outline.find((o) => o.id === section.outlineId);
  if (!outlineEntry) return { ok: false, error: 'outline_entry_not_found' };

  const company = await db.query.companies.findFirst({
    where: (c, { eq: _eq }) => _eq(c.id, ctx.companyId),
  });
  if (!company) return { ok: false, error: 'company_not_found' };

  // Retrieve library excerpts if embeddings are configured.
  let libraryExcerpts: Array<{ title: string; type: string; content: string }> = [];
  if (process.env.OPENAI_API_KEY) {
    try {
      const emb = await embedText(`${outlineEntry.title}. ${outlineEntry.description}`);
      await meterEmbedding({
        companyId: ctx.companyId,
        tokens: Math.ceil((outlineEntry.title.length + outlineEntry.description.length) / 4),
      });
      const [lib, pp] = await Promise.all([
        semanticSearchLibrary(ctx.companyId, emb, 3),
        semanticSearchPastPerformance(ctx.companyId, emb, 2),
      ]);
      libraryExcerpts = [
        ...lib.map((l) => ({ title: l.title, type: l.type, content: l.content })),
        ...pp.map((p) => ({
          title: p.projectName,
          type: 'past_performance',
          content: [p.scopeDescription, p.outcomes].filter(Boolean).join('\n\n'),
        })),
      ];
    } catch (err) {
      console.warn('library retrieval skipped:', err);
    }
  }

  const result = await draftSection({
    opportunity: {
      title: row.oppTitle,
      jurisdiction: '',
      referenceNumber: row.oppReferenceNumber,
      description: row.oppDescription,
    },
    company: { name: company.name, country: company.country, capabilities: company.capabilities ?? [] },
    section: {
      number: outlineEntry.number,
      title: outlineEntry.title,
      description: outlineEntry.description,
      evaluationCriteria: outlineEntry.evaluationCriteria,
      mandatoryContent: outlineEntry.mandatoryContent,
      pageLimit: outlineEntry.pageLimit,
    },
    libraryExcerpts,
    existingContent: section.content || undefined,
    userInstruction: payload.userInstruction ?? undefined,
  });
  await meter({
    companyId: ctx.companyId,
    source: 'draft_section',
    model: MODELS.sonnet,
    usage: result.usage,
  });

  const nextSections = sections.map((s) =>
    s.id === payload.sectionId
      ? {
          ...s,
          content: result.content,
          status: 'ai_drafted' as const,
          wordCount: result.wordCount,
          lastEditedAt: new Date().toISOString(),
        }
      : s,
  );
  await db
    .update(proposals)
    .set({ sections: nextSections, updatedAt: new Date() })
    .where(eq(proposals.id, row.proposalId));

  revalidatePath(`/proposal/${payload.pursuitId}`);
  return {
    ok: true,
    result: {
      proposalId: row.proposalId,
      sectionId: payload.sectionId,
      wordCount: result.wordCount,
      redirectTo: `/proposal/${payload.pursuitId}`,
    },
  };
};

const createAlertSchema = z.object({
  name: z.string(),
  jurisdictions: z.array(z.string()).nullable().optional(),
  categories: z.array(z.string()).nullable().optional(),
  keywords: z.array(z.string()).nullable().optional(),
  excludeKeywords: z.array(z.string()).nullable().optional(),
  minValue: z.number().nullable().optional(),
  maxValue: z.number().nullable().optional(),
  frequency: z.enum(['instant', 'daily', 'weekly']).optional(),
});

const createAlert: ApplyHandler = async (ctx, rawPayload) => {
  const payload = createAlertSchema.parse(rawPayload);

  const row: NewAlertProfile = {
    userId: ctx.userId,
    companyId: ctx.companyId,
    name: payload.name,
    jurisdictions: payload.jurisdictions ?? null,
    categories: payload.categories ?? null,
    keywords: payload.keywords ?? null,
    excludeKeywords: payload.excludeKeywords ?? null,
    minValue: payload.minValue != null ? String(payload.minValue) : null,
    maxValue: payload.maxValue != null ? String(payload.maxValue) : null,
    frequency: payload.frequency ?? 'daily',
  };
  const [created] = await db
    .insert(alertProfiles)
    .values(row)
    .returning({ id: alertProfiles.id });
  if (!created) return { ok: false, error: 'insert_failed' };

  revalidatePath('/alerts');
  return {
    ok: true,
    result: { alertId: created.id, redirectTo: `/alerts/${created.id}` },
  };
};

// -- Registry ----------------------------------------------------------------

const approvalContextSchema = z.object({
  status: z.enum([
    'pending',
    'kyc_in_progress',
    'approved_without_kyc',
    'approved_with_kyc',
    'rejected',
    'expired',
  ]),
  approvedAt: z.string().nullable(),
  expiresAt: z.string().nullable(),
  notes: z.string().nullable(),
});

const productSpecSchema = z.object({
  property: z.string(),
  astmMethod: z.string().nullable(),
  units: z.string().nullable(),
  min: z.string().nullable(),
  max: z.string().nullable(),
  typical: z.string().nullable(),
});

const sourceDocumentSchema = z.object({
  url: z.string().url(),
  contentType: z.string(),
  filename: z.string(),
});

const pushToVexSchema = z.object({
  sourceRef: z.string(),
  legalName: z.string(),
  country: z.string().nullable(),
  role: z.string().nullable(),
  contactName: z.string().nullable(),
  contactEmail: z.string().nullable(),
  contactPhone: z.string().nullable(),
  contactTitle: z.string().nullable().optional(),
  contactLinkedinUrl: z.string().nullable().optional(),
  commercialContext: z.object({
    categories: z.array(z.string()),
    awardCount: z.number(),
    awardTotalUsd: z.number().nullable(),
    daysSinceLastAward: z.number().nullable(),
    distressSignals: z.array(
      z.object({
        kind: z.string(),
        detail: z.string(),
        observedAt: z.string().nullable(),
      }),
    ),
    notes: z.string().nullable(),
    procurEntityProfileUrl: z.string(),
  }),
  originationContext: z.object({
    chatSummary: z.string().nullable(),
    userNote: z.string().nullable(),
  }),
  // Optional richer context — when the chat-tool proposal carries
  // these (e.g. doc-extraction surfaced specs + the source PDF),
  // ship them alongside the rest of the payload.
  approvalContext: approvalContextSchema.nullable().optional(),
  productSpecs: z.array(productSpecSchema).optional(),
  sourceDocuments: z.array(sourceDocumentSchema).optional(),
});

const pushToVex: ApplyHandler = async (ctx, rawPayload) => {
  const payload = pushToVexSchema.parse(rawPayload);
  const { qualifyAsLead } = await import('@procur/catalog');
  const richContext = await resolveRichVexContext(ctx, payload);

  const result = await qualifyAsLead({
    sourceRef: payload.sourceRef,
    triggeredBy: `procur-assistant:user:${ctx.userId}`,
    legalName: payload.legalName,
    country: payload.country,
    domain: null,
    role: payload.role,
    contact:
      payload.contactName || payload.contactEmail || payload.contactPhone
        ? {
            name: payload.contactName,
            email: payload.contactEmail,
            phone: payload.contactPhone,
            title: payload.contactTitle ?? null,
            linkedinUrl: payload.contactLinkedinUrl ?? null,
          }
        : null,
    chatSummary: payload.originationContext.chatSummary,
    userNote: payload.originationContext.userNote,
    procurMetadata: {
      ...(payload.approvalContext
        ? { procurApproval: payload.approvalContext }
        : richContext.approvalContext
          ? { procurApproval: richContext.approvalContext }
          : {}),
      ...(payload.productSpecs && payload.productSpecs.length > 0
        ? { productSpecs: payload.productSpecs }
        : {}),
      ...(payload.sourceDocuments && payload.sourceDocuments.length > 0
        ? { sourceDocuments: payload.sourceDocuments }
        : {}),
      ...(richContext.marketContext
        ? { marketContext: richContext.marketContext }
        : {}),
      ...(richContext.procurTradingDefaults
        ? { procurTradingDefaults: richContext.procurTradingDefaults }
        : {}),
    },
  });

  return {
    ok: true,
    result: {
      leadId: result.leadId,
      dedupedAgainstExisting: result.dedupedAgainstExisting,
      redirectTo: result.leadUrl,
    },
  };
};

/**
 * Resolve the procur-side context that vex's worker wants to see on
 * every push but that the assistant tool doesn't have to thread
 * through manually. Pulled at apply-time so the values are fresh.
 *
 * Three pieces:
 *   1. Approval status for this entity, if procur tracks one.
 *   2. The market snapshot at push time (Brent + NYH spots).
 *   3. The procur company's trading-economics defaults so vex can
 *      segment leads by desk profile.
 */
async function resolveRichVexContext(
  ctx: { companyId: string },
  payload: { sourceRef: string },
): Promise<{
  approvalContext: VexApprovalContextLite | null;
  marketContext: VexMarketContextLite | null;
  procurTradingDefaults: VexTradingDefaultsLite | null;
}> {
  const {
    getCompanyDealDefaults,
    getMarketMoveBanner,
    getSupplierApproval,
  } = await import('@procur/catalog');

  // sourceRef shape varies (entity-profile:<slug>, match:<id>, …).
  // We only auto-attach approval when the prefix tells us which
  // entity to look up; chat tools that pass the entity slug
  // directly should also include approvalContext on the payload.
  let entitySlug: string | null = null;
  if (payload.sourceRef.startsWith('entity-profile:')) {
    entitySlug = payload.sourceRef.slice('entity-profile:'.length);
  }

  const [approval, banner, defaults] = await Promise.all([
    entitySlug
      ? getSupplierApproval(ctx.companyId, entitySlug).catch(() => null)
      : Promise.resolve(null),
    getMarketMoveBanner(7, 0).catch(() => null),
    getCompanyDealDefaults(ctx.companyId).catch(() => null),
  ]);

  return {
    approvalContext: approval
      ? {
          status: approval.status,
          approvedAt: approval.approvedAt,
          expiresAt: approval.expiresAt,
          notes: approval.notes,
        }
      : null,
    marketContext: banner
      ? {
          benchmarkAsOf: banner.series[0]?.latestAsOf ?? null,
          brentSpotUsdPerBbl:
            banner.series.find((s) => s.seriesSlug === 'brent')?.latestPrice ?? null,
          nyhDieselSpotUsdPerGal:
            banner.series.find((s) => s.seriesSlug === 'nyh-diesel')?.latestPrice ??
            null,
          nyhGasolineSpotUsdPerGal:
            banner.series.find((s) => s.seriesSlug === 'nyh-gasoline')?.latestPrice ??
            null,
        }
      : null,
    procurTradingDefaults: defaults
      ? {
          defaultSourcingRegion: defaults.defaultSourcingRegion ?? null,
          targetGrossMarginPct: defaults.targetGrossMarginPct ?? null,
          targetNetMarginPerUsg: defaults.targetNetMarginPerUsg ?? null,
          monthlyFixedOverheadUsdDefault: defaults.monthlyFixedOverheadUsdDefault ?? null,
        }
      : null,
  };
}

// Local type aliases for the rich-context resolver. Phase 4
// vex-into-procur merge: the canonical shapes are defined inline on
// LeadProcurMetadata in @procur/db. These narrow lite versions stay
// here because the resolver predates the merge and treats every field
// as nullable; LeadProcurMetadata uses optional fields with similar
// values. The resolver result feeds qualifyAsLead's procurMetadata.
type VexApprovalContextLite = {
  status:
    | 'pending'
    | 'kyc_in_progress'
    | 'approved_without_kyc'
    | 'approved_with_kyc'
    | 'rejected'
    | 'expired';
  approvedAt: string | null;
  expiresAt: string | null;
  notes: string | null;
};
type VexMarketContextLite = {
  benchmarkAsOf: string | null;
  brentSpotUsdPerBbl: number | null;
  nyhDieselSpotUsdPerGal: number | null;
  nyhGasolineSpotUsdPerGal: number | null;
};
type VexTradingDefaultsLite = {
  defaultSourcingRegion: string | null;
  targetGrossMarginPct: number | null;
  targetNetMarginPerUsg: number | null;
  monthlyFixedOverheadUsdDefault: number | null;
};

const pushManyToVexSchema = z.object({
  pushes: z
    .array(
      z.object({
        sourceRef: z.string(),
        entitySlug: z.string().optional(),
        legalName: z.string(),
        country: z.string().nullable(),
        role: z.string().nullable(),
        contactName: z.string().nullable(),
        contactEmail: z.string().nullable(),
        contactPhone: z.string().nullable(),
        commercialContext: z.object({
          categories: z.array(z.string()),
          awardCount: z.number(),
          awardTotalUsd: z.number().nullable(),
          daysSinceLastAward: z.number().nullable(),
          distressSignals: z.array(
            z.object({
              kind: z.string(),
              detail: z.string(),
              observedAt: z.string().nullable(),
            }),
          ),
          notes: z.string().nullable(),
          procurEntityProfileUrl: z.string(),
        }),
        originationContext: z.object({
          chatSummary: z.string().nullable(),
          userNote: z.string().nullable(),
        }),
      }),
    )
    .min(1)
    .max(50),
  chatSummary: z.string(),
  userNote: z.string().nullable(),
});

/**
 * Bulk-push handler. Iterates the pre-resolved pushes from the
 * proposal and calls vex once per entity. Failures are collected,
 * not thrown — vex 502/timeouts on entity #7 shouldn't drop pushes
 * for entities #8-50. The result summary tells the user how many
 * landed, which failed, and surfaces the first vex URL so they
 * have somewhere to click.
 */
const pushManyToVex: ApplyHandler = async (ctx, rawPayload) => {
  const payload = pushManyToVexSchema.parse(rawPayload);
  const { qualifyAsLead, getSupplierApproval } = await import('@procur/catalog');

  type PerResult = {
    legalName: string;
    ok: boolean;
    leadId?: string;
    leadUrl?: string;
    dedupedAgainstExisting?: boolean;
    error?: string;
  };

  // Resolve the company-level rich context once — market snapshot
  // and trading defaults don't vary per push within a single bulk
  // request. Per-entity approval still resolves inside the loop.
  const sharedRich = await resolveRichVexContext(ctx, { sourceRef: '' });
  const results: PerResult[] = [];
  for (const push of payload.pushes) {
    const perEntityApproval = push.entitySlug
      ? await getSupplierApproval(ctx.companyId, push.entitySlug).catch(
          () => null,
        )
      : null;

    try {
      const r = await qualifyAsLead({
        sourceRef: push.sourceRef,
        triggeredBy: `procur-assistant-bulk:user:${ctx.userId}`,
        legalName: push.legalName,
        country: push.country,
        domain: null,
        role: push.role,
        contact:
          push.contactName || push.contactEmail || push.contactPhone
            ? {
                name: push.contactName,
                email: push.contactEmail,
                phone: push.contactPhone,
                title: null,
                linkedinUrl: null,
              }
            : null,
        chatSummary: push.originationContext.chatSummary,
        userNote: push.originationContext.userNote,
        procurMetadata: {
          ...(perEntityApproval
            ? {
                procurApproval: {
                  status: perEntityApproval.status,
                  approvedAt: perEntityApproval.approvedAt,
                  expiresAt: perEntityApproval.expiresAt,
                  notes: perEntityApproval.notes,
                },
              }
            : {}),
          ...(sharedRich.marketContext
            ? { marketContext: sharedRich.marketContext }
            : {}),
          ...(sharedRich.procurTradingDefaults
            ? { procurTradingDefaults: sharedRich.procurTradingDefaults }
            : {}),
        },
      });
      results.push({
        legalName: push.legalName,
        ok: true,
        leadId: r.leadId,
        leadUrl: r.leadUrl,
        dedupedAgainstExisting: r.dedupedAgainstExisting,
      });
    } catch (err) {
      results.push({
        legalName: push.legalName,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const succeeded = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);
  const firstUrl = succeeded[0]?.leadUrl ?? null;

  return {
    ok: true,
    result: {
      totalRequested: payload.pushes.length,
      pushed: succeeded.length,
      failed: failed.length,
      dedupedAgainstExisting: succeeded.filter((r) => r.dedupedAgainstExisting).length,
      results,
      // First-success URL so the chat surface has somewhere to send
      // the user. The full per-entity URL list lives in `results`.
      redirectTo: firstUrl,
    },
  };
};

const createKnownEntitySchema = z.object({
  slug: z.string().min(3),
  name: z.string().min(2),
  country: z.string().length(2),
  role: z.string().min(2),
  categories: z.array(z.string()).min(1),
  notes: z.string().nullable(),
  aliases: z.array(z.string()),
  tags: z.array(z.string()),
  metadata: z.record(z.unknown()),
  latitude: z.number().nullable(),
  longitude: z.number().nullable(),
});

/**
 * Compose the identity-text payload for entity_text_embeddings —
 * MUST match seed-entity-text-embeddings.ts's composeSourceText so
 * the on-create write and the periodic backfill share a vector
 * space. Tied to embeddingKind 'combined_v1'.
 */
function composeEntitySourceText(args: {
  name: string;
  aliases: string[];
  country: string;
  role: string;
  categories: string[];
  notes: string | null;
}): string {
  const parts: string[] = [args.name];
  if (args.aliases.length > 0) parts.push(`aka: ${args.aliases.join(', ')}`);
  parts.push(`country: ${args.country}`);
  parts.push(`role: ${args.role}`);
  if (args.categories.length > 0) {
    parts.push(`categories: ${args.categories.join(', ')}`);
  }
  if (args.notes) parts.push(args.notes.slice(0, 500));
  return parts.join('\n');
}

function vectorLiteral(values: number[]): string {
  return `[${values.map((v) => v.toFixed(8)).join(',')}]`;
}

const TEXT_EMBEDDING_KIND_COMBINED_V1 = 'combined_v1';

/**
 * Embed the entity's identity text and upsert into
 * entity_text_embeddings. Idempotent on (slug, kind, model_version).
 * Caller is responsible for try/catch — failures must not roll back
 * the parent insert.
 */
async function embedAndUpsertEntityText(args: {
  slug: string;
  name: string;
  country: string;
  role: string;
  categories: string[];
  aliases: string[];
  notes: string | null;
}): Promise<void> {
  const sourceText = composeEntitySourceText(args);
  const vec = await embedText(sourceText);
  await db.execute(sqlTag`
    INSERT INTO entity_text_embeddings (
      entity_slug, embedding_kind, embedding, source_text, model_version
    ) VALUES (
      ${args.slug},
      ${TEXT_EMBEDDING_KIND_COMBINED_V1},
      ${vectorLiteral(vec)}::vector,
      ${sourceText},
      ${EMBEDDING_MODEL}
    )
    ON CONFLICT (entity_slug, embedding_kind, model_version)
    DO UPDATE SET
      embedding = EXCLUDED.embedding,
      source_text = EXCLUDED.source_text,
      created_at = now();
  `);
}

/**
 * Strip protocol + path + leading "www." from a website URL so the
 * resulting string is a bare apex/subdomain suitable for the
 * `known_entities.primary_domain` column. Returns null on garbage.
 *
 *   https://www.motiva.com/         → motiva.com
 *   http://klesch.com:8080/refining → klesch.com
 *   not-a-url                       → null
 */
function deriveDomainFromUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  try {
    const u = new URL(value.trim());
    return u.hostname.replace(/^www\./i, '').toLowerCase() || null;
  } catch {
    // Bare-host fallback (e.g. metadata stored as "motiva.com" without scheme).
    const m = value.trim().match(/^(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}$/);
    return m ? value.trim().replace(/^www\./i, '').toLowerCase() : null;
  }
}

/**
 * Insert a new analyst-rolodex row from the chat-curated path.
 * Conflict on slug returns the existing row's path so the operator
 * can navigate to it instead of getting a confusing duplicate error
 * (the proposal step already checks; this is the race-safe fallback).
 *
 * Domain-driven enrichment: when the proposal carries a website URL
 * in metadata, populate `primary_domain` on the row AND fire a single
 * Apollo `enrichOrgsBatch` so the entity is linked to its Apollo org
 * before the next chat tool call (find_decision_makers_at_entity,
 * getApolloEntityCache, etc.). Best-effort — Apollo failures must
 * never roll back the create.
 */
const createKnownEntity: ApplyHandler = async (_ctx, rawPayload) => {
  const payload = createKnownEntitySchema.parse(rawPayload);

  const primaryDomain = deriveDomainFromUrl(
    (payload.metadata as Record<string, unknown> | null | undefined)?.[
      'website_url'
    ],
  );

  const row: NewKnownEntity = {
    slug: payload.slug,
    name: payload.name,
    country: payload.country.toUpperCase(),
    role: payload.role,
    categories: payload.categories,
    notes: payload.notes,
    aliases: payload.aliases,
    tags: payload.tags,
    metadata: payload.metadata,
    latitude: payload.latitude == null ? null : String(payload.latitude),
    longitude: payload.longitude == null ? null : String(payload.longitude),
    primaryDomain,
  };

  try {
    const [created] = await db
      .insert(knownEntities)
      .values(row)
      .returning({ id: knownEntities.id, slug: knownEntities.slug });
    if (!created) return { ok: false, error: 'insert_failed' };

    // Best-effort Apollo link. enrichOrgsBatch matches by domain via
    // POST /mixed_companies/search and writes apollo_org_id + the
    // thin snapshot back onto the row. Failures (rate limit, network,
    // Apollo down) must NEVER roll back the create — log and move on.
    // The next chat tool call (find_decision_makers_at_entity etc.)
    // will then have a live apolloOrgId to filter by.
    if (primaryDomain) {
      try {
        await enrichOrgsBatch({
          domains: [primaryDomain],
          targetTable: 'known_entities',
        });
      } catch (apolloErr) {
        console.warn(
          JSON.stringify({
            level: 'warn',
            service: 'assistant.apply.createKnownEntity',
            msg: 'apollo enrichOrgsBatch failed — continuing',
            slug: created.slug,
            primaryDomain,
            error: apolloErr instanceof Error ? apolloErr.message : String(apolloErr),
          }),
        );
      }
    }

    // Best-effort text embedding for ML mention-resolution. Mirrors
    // the seed-entity-text-embeddings.ts source-text composition so
    // backfill batches and on-create writes share an identity space.
    // ~$0.0001 per row at text-embedding-3-small pricing. Failures
    // (OpenAI rate limit, no API key in dev, Postgres congestion)
    // must NEVER roll back the create — log and move on; the
    // nightly seed script will pick up the gap.
    try {
      await embedAndUpsertEntityText({
        slug: created.slug,
        name: payload.name,
        country: payload.country.toUpperCase(),
        role: payload.role,
        categories: payload.categories,
        aliases: payload.aliases,
        notes: payload.notes,
      });
    } catch (embedErr) {
      console.warn(
        JSON.stringify({
          level: 'warn',
          service: 'assistant.apply.createKnownEntity',
          msg: 'text-embedding upsert failed — continuing',
          slug: created.slug,
          error: embedErr instanceof Error ? embedErr.message : String(embedErr),
        }),
      );
    }

    return {
      ok: true,
      result: {
        entityId: created.id,
        slug: created.slug,
        redirectTo: `/entities/${created.slug}`,
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Postgres unique-constraint violation surfaces as "duplicate key
    // value violates unique constraint". The proposal step already
    // checks for this, but a race between proposal and apply can land
    // here — return the existing slug so the user has somewhere to go.
    if (/duplicate key/i.test(msg)) {
      return {
        ok: true,
        result: {
          entityId: null,
          slug: payload.slug,
          redirectTo: `/entities/${payload.slug}`,
          dedupedAgainstExisting: true,
        },
      };
    }
    return { ok: false, error: 'insert_failed', message: msg };
  }
};

const updateKnownEntitySchema = z.object({
  slug: z.string().min(3),
  notes: z.string().nullable(),
  country: z.string().length(2),
  role: z.string().min(2),
  categories: z.array(z.string()).min(1),
  aliases: z.array(z.string()),
  tags: z.array(z.string()),
  metadata: z.record(z.unknown()),
  latitude: z.string().nullable(),
  longitude: z.string().nullable(),
});

/**
 * Apply a partial-update merge to an existing known_entities row.
 * The proposal step has already computed the merged values and the
 * diff; this step just persists them. UPDATE-by-slug is race-safe
 * (no INSERT to collide), and audit_log capture in applyProposal
 * gives us the before/after trail.
 */
const updateKnownEntity: ApplyHandler = async (_ctx, rawPayload) => {
  const payload = updateKnownEntitySchema.parse(rawPayload);

  // Mirror the create path: derive primary_domain from
  // metadata.website_url so Apollo's matcher (which reads
  // known_entities.primary_domain, NOT metadata.website_url) picks
  // up the website on the next refresh. Without this, the domain
  // update is invisible to Apollo even though the tile link works.
  const primaryDomain = deriveDomainFromUrl(
    (payload.metadata as Record<string, unknown>)?.['website_url'],
  );

  const result = await db
    .update(knownEntities)
    .set({
      notes: payload.notes,
      country: payload.country,
      role: payload.role,
      categories: payload.categories,
      aliases: payload.aliases,
      tags: payload.tags,
      metadata: payload.metadata,
      latitude: payload.latitude,
      longitude: payload.longitude,
      // Only set primary_domain when we successfully derived one —
      // a metadata-only update with no website_url shouldn't wipe
      // an existing domain that Apollo already matched against.
      ...(primaryDomain ? { primaryDomain } : {}),
      updatedAt: new Date(),
    })
    .where(eq(knownEntities.slug, payload.slug))
    .returning({ id: knownEntities.id, slug: knownEntities.slug });

  const [updated] = result;
  if (!updated) {
    return {
      ok: false,
      error: 'entity_not_found',
      message: `No entity with slug "${payload.slug}" — concurrent delete?`,
    };
  }

  return {
    ok: true,
    result: {
      entityId: updated.id,
      slug: updated.slug,
      redirectTo: `/entities/${updated.slug}`,
    },
  };
};

const HANDLERS: Record<string, ApplyHandler> = {
  propose_create_pursuit: createPursuit,
  propose_advance_stage: advanceStage,
  propose_create_task: createTask,
  propose_draft_proposal_section: draftProposalSection,
  propose_create_alert_profile: createAlert,
  propose_push_to_vex_contact: pushToVex,
  propose_push_many_to_vex_contacts: pushManyToVex,
  propose_create_known_entity: createKnownEntity,
  propose_update_known_entity: updateKnownEntity,
};

export async function applyProposal(
  ctx: ApplyContext,
  toolName: string,
  applyPayload: unknown,
): Promise<ApplyResult> {
  const handler = HANDLERS[toolName];
  if (!handler) return { ok: false, error: 'unknown_tool' };

  try {
    const result = await handler(ctx, applyPayload);
    // Audit every application regardless of outcome so we have a record of
    // what the agent proposed and what the user accepted.
    await db.insert(auditLog).values({
      companyId: ctx.companyId,
      userId: ctx.userId,
      action: `assistant.${toolName}`,
      entityType: 'assistant_thread',
      entityId: ctx.threadId,
      changes: { payload: applyPayload, result },
      metadata: { source: 'assistant_apply' },
    });
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db.insert(auditLog).values({
      companyId: ctx.companyId,
      userId: ctx.userId,
      action: `assistant.${toolName}.error`,
      entityType: 'assistant_thread',
      entityId: ctx.threadId,
      changes: { payload: applyPayload, error: message },
      metadata: { source: 'assistant_apply' },
    });
    return { ok: false, error: 'apply_failed', message };
  }
}
