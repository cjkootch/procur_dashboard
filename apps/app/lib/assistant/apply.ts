import 'server-only';
import { and, eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { draftSection, embedText, meter, meterEmbedding, MODELS } from '@procur/ai';
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

const pushToVexSchema = z.object({
  sourceRef: z.string(),
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
});

const pushToVex: ApplyHandler = async (ctx, rawPayload) => {
  const payload = pushToVexSchema.parse(rawPayload);
  const { pushVexContact } = await import('../vex-client');

  const result = await pushVexContact({
    source: 'procur',
    sourceRef: payload.sourceRef,
    legalName: payload.legalName,
    country: payload.country,
    role: payload.role,
    contactName: payload.contactName,
    contactEmail: payload.contactEmail,
    contactPhone: payload.contactPhone,
    commercialContext: payload.commercialContext,
    originationContext: {
      triggeredBy: `procur-assistant:user:${ctx.userId}`,
      chatSummary: payload.originationContext.chatSummary,
      userNote: payload.originationContext.userNote,
      pushedAt: new Date().toISOString(),
    },
  });

  if (!result.ok) {
    return {
      ok: false,
      error: 'vex_push_failed',
      message: result.error,
    };
  }

  return {
    ok: true,
    result: {
      vexContactId: result.data.vexContactId,
      dedupedAgainstExisting: result.data.dedupedAgainstExisting,
      redirectTo: result.data.vexRecordUrl,
    },
  };
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
  const { pushVexContact } = await import('../vex-client');

  type PerResult = {
    legalName: string;
    ok: boolean;
    vexContactId?: string;
    vexRecordUrl?: string;
    dedupedAgainstExisting?: boolean;
    error?: string;
  };

  const pushedAt = new Date().toISOString();
  const results: PerResult[] = [];
  for (const push of payload.pushes) {
    const r = await pushVexContact({
      source: 'procur',
      sourceRef: push.sourceRef,
      legalName: push.legalName,
      country: push.country,
      role: push.role,
      contactName: push.contactName,
      contactEmail: push.contactEmail,
      contactPhone: push.contactPhone,
      commercialContext: push.commercialContext,
      originationContext: {
        triggeredBy: `procur-assistant-bulk:user:${ctx.userId}`,
        chatSummary: push.originationContext.chatSummary,
        userNote: push.originationContext.userNote,
        pushedAt,
      },
    });
    if (r.ok) {
      results.push({
        legalName: push.legalName,
        ok: true,
        vexContactId: r.data.vexContactId,
        vexRecordUrl: r.data.vexRecordUrl,
        dedupedAgainstExisting: r.data.dedupedAgainstExisting,
      });
    } else {
      results.push({
        legalName: push.legalName,
        ok: false,
        error: r.error,
      });
    }
  }

  const succeeded = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);
  const firstUrl = succeeded[0]?.vexRecordUrl ?? null;

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
 * Insert a new analyst-rolodex row from the chat-curated path.
 * Conflict on slug returns the existing row's path so the operator
 * can navigate to it instead of getting a confusing duplicate error
 * (the proposal step already checks; this is the race-safe fallback).
 */
const createKnownEntity: ApplyHandler = async (_ctx, rawPayload) => {
  const payload = createKnownEntitySchema.parse(rawPayload);

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
  };

  try {
    const [created] = await db
      .insert(knownEntities)
      .values(row)
      .returning({ id: knownEntities.id, slug: knownEntities.slug });
    if (!created) return { ok: false, error: 'insert_failed' };
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
