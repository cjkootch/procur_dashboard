import 'server-only';
import { and, eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { draftSection, embedText, meter, meterEmbedding, MODELS } from '@procur/ai';
import {
  alertProfiles,
  auditLog,
  db,
  opportunities,
  proposals,
  pursuits,
  pursuitTasks,
  type NewAlertProfile,
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

const HANDLERS: Record<string, ApplyHandler> = {
  propose_create_pursuit: createPursuit,
  propose_advance_stage: advanceStage,
  propose_create_task: createTask,
  propose_draft_proposal_section: draftProposalSection,
  propose_create_alert_profile: createAlert,
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
