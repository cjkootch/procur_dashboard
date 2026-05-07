import 'server-only';
import { and, desc, eq, sql } from 'drizzle-orm';
import {
  agentRuns,
  approvals,
  costLedger,
  db,
  events,
  feedbackEvents,
} from '@procur/db';
import { ActionDescriptor, createId, type ActionDescriptorT } from '@procur/ai';
import {
  buildOutreachFeatures,
  recordOutreachFeatureSnapshot,
} from './outreach-features';

/**
 * Read/write helpers for the agent runtime (vex-into-procur merge
 * Phase 2). Pairs with the AgentRunner + ApprovalGate in @procur/ai;
 * those write rows, these read them for the approval-queue UI and
 * (later phases) the executor service.
 */

export interface AgentRunListRow {
  id: string;
  agentName: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  costUsd: number;
  startedAt: Date | null;
  finishedAt: Date | null;
  createdAt: Date;
  error: string | null;
  outputRefs: Record<string, unknown>;
}

export async function listAgentRuns(
  options: {
    status?: 'pending' | 'running' | 'completed' | 'failed';
    limit?: number;
  } = {},
): Promise<AgentRunListRow[]> {
  const limit = options.limit ?? 50;
  const rows = await db
    .select({
      id: agentRuns.id,
      agentName: agentRuns.agentName,
      status: agentRuns.status,
      costUsd: agentRuns.costUsd,
      startedAt: agentRuns.startedAt,
      finishedAt: agentRuns.finishedAt,
      createdAt: agentRuns.createdAt,
      error: agentRuns.error,
      outputRefs: agentRuns.outputRefs,
    })
    .from(agentRuns)
    .where(options.status ? eq(agentRuns.status, options.status) : undefined)
    .orderBy(desc(agentRuns.createdAt))
    .limit(limit);
  return rows as AgentRunListRow[];
}

export interface ApprovalListRow {
  id: string;
  agentRunId: string | null;
  actionType: string;
  decision: 'pending' | 'approved' | 'rejected' | 'auto_approved';
  proposedPayload: Record<string, unknown>;
  reviewerId: string | null;
  decidedAt: Date | null;
  appliedObjectId: string | null;
  appliedAt: Date | null;
  createdAt: Date;
}

export async function listPendingApprovals(
  options: { limit?: number } = {},
): Promise<ApprovalListRow[]> {
  const limit = options.limit ?? 20;
  const rows = await db
    .select({
      id: approvals.id,
      agentRunId: approvals.agentRunId,
      actionType: approvals.actionType,
      decision: approvals.decision,
      proposedPayload: approvals.proposedPayload,
      reviewerId: approvals.reviewerId,
      decidedAt: approvals.decidedAt,
      appliedObjectId: approvals.appliedObjectId,
      appliedAt: approvals.appliedAt,
      createdAt: approvals.createdAt,
    })
    .from(approvals)
    .where(eq(approvals.decision, 'pending'))
    .orderBy(desc(approvals.createdAt))
    .limit(limit);
  return rows as ApprovalListRow[];
}

export async function getApproval(
  id: string,
): Promise<ApprovalListRow | null> {
  const rows = await db
    .select({
      id: approvals.id,
      agentRunId: approvals.agentRunId,
      actionType: approvals.actionType,
      decision: approvals.decision,
      proposedPayload: approvals.proposedPayload,
      reviewerId: approvals.reviewerId,
      decidedAt: approvals.decidedAt,
      appliedObjectId: approvals.appliedObjectId,
      appliedAt: approvals.appliedAt,
      createdAt: approvals.createdAt,
    })
    .from(approvals)
    .where(eq(approvals.id, id))
    .limit(1);
  return (rows[0] as ApprovalListRow | undefined) ?? null;
}

/**
 * Record a reviewer's decision. Idempotent on the (id, decision)
 * pair — re-applying the same decision is a no-op. Emits an
 * `approval.decided` audit event into the partitioned events table.
 */
export async function recordApprovalDecision(
  id: string,
  input: {
    decision: 'approved' | 'rejected' | 'auto_approved';
    reviewerId?: string | null;
  },
): Promise<{ updated: boolean; row: ApprovalListRow | null }> {
  const now = new Date();
  const updated = await db
    .update(approvals)
    .set({
      decision: input.decision,
      reviewerId: input.reviewerId ?? null,
      decidedAt: now,
    })
    .where(and(eq(approvals.id, id), eq(approvals.decision, 'pending')))
    .returning({ id: approvals.id });

  const row = await getApproval(id);

  if (updated.length > 0 && row) {
    await db
      .insert(events)
      .values({
        id: createId(),
        verb: `approval.${input.decision}`,
        subjectType: 'approval',
        subjectId: id,
        actorType: input.reviewerId ? 'user' : 'system',
        actorId: input.reviewerId ?? 'system',
        objectType: 'approval',
        objectId: id,
        occurredAt: now,
        idempotencyKey: `approval.${input.decision}:${id}`,
        metadata: { action_type: row.actionType },
      })
      .onConflictDoNothing({
        target: [events.occurredAt, events.idempotencyKey],
      });
  }

  return { updated: updated.length > 0, row };
}

/**
 * Edit a single field on a pending approval's `proposed_payload` and
 * record the before/after to `feedback_events` for later fine-tuning
 * (operator's voice on a given action type — what the model drafted
 * vs what the operator actually wanted to send).
 *
 * Refuses non-pending approvals so a half-fired SMS can't be
 * silently retconned. The whitelist of editable fields lives client-
 * side per action type; the server validates that the field is one
 * of `body / subject / aiInstructions / goalHint` (the four free-
 * text fields that cover sms / email / call). Other fields are
 * structural and not editable from the chat preview.
 */
export async function editApprovalPayloadField(input: {
  approvalId: string;
  field: 'body' | 'subject' | 'aiInstructions' | 'goalHint';
  value: string;
  userId: string | null;
}): Promise<
  | { ok: true; row: ApprovalListRow }
  | { ok: false; reason: 'not_found' | 'not_pending' | 'unchanged' }
> {
  const existing = await getApproval(input.approvalId);
  if (!existing) return { ok: false, reason: 'not_found' };
  if (existing.decision !== 'pending') {
    return { ok: false, reason: 'not_pending' };
  }
  const before = existing.proposedPayload[input.field];
  if (typeof before === 'string' && before === input.value) {
    return { ok: false, reason: 'unchanged' };
  }
  const nextPayload = {
    ...existing.proposedPayload,
    [input.field]: input.value,
  };
  await db
    .update(approvals)
    .set({ proposedPayload: nextPayload })
    .where(
      and(
        eq(approvals.id, input.approvalId),
        eq(approvals.decision, 'pending'),
      ),
    );
  // Training signal: record the operator's revision so we can later
  // fine-tune the model on (action_type + draft → preferred phrasing).
  // sentiment is left null — the brief's enum doesn't have an "edit"
  // value; the kind alone is enough to query.
  await db.insert(feedbackEvents).values({
    userId: input.userId ?? null,
    feedbackKind: 'communication_edit',
    targetType: 'approval',
    targetId: input.approvalId,
    payload: {
      action_type: existing.actionType,
      field: input.field,
      before: typeof before === 'string' ? before : null,
      after: input.value,
    },
  });
  const updated = await getApproval(input.approvalId);
  if (!updated) return { ok: false, reason: 'not_found' };
  return { ok: true, row: updated };
}

/**
 * Sum cost_ledger micros for today (UTC). Powers the in-app cost
 * meter and matches the AgentRunner pre-run gate's calculation. Fails
 * open — returns 0 on query failure rather than blocking the UI.
 */
export async function sumCostLedgerToday(now: Date = new Date()): Promise<{
  micros: number;
  usd: number;
}> {
  const start = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      0,
      0,
      0,
      0,
    ),
  );
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  try {
    const rows = await db
      .select({
        total: sql<number>`coalesce(sum(${costLedger.costUsdMicros}), 0)::bigint`,
      })
      .from(costLedger)
      .where(
        sql`${costLedger.occurredAt} >= ${start} AND ${costLedger.occurredAt} < ${end}`,
      );
    const micros = Number(rows[0]?.total ?? 0);
    return { micros, usd: micros / 1_000_000 };
  } catch {
    return { micros: 0, usd: 0 };
  }
}

/**
 * Count of pending approvals — used by the global nav badge.
 */
export async function countPendingApprovals(): Promise<number> {
  try {
    const rows = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(approvals)
      .where(eq(approvals.decision, 'pending'));
    return Number(rows[0]?.count ?? 0);
  } catch {
    return 0;
  }
}

/**
 * Insert an approval row from the chat-tool surface (vex-into-procur
 * merge Phase 7.6). Mirrors @procur/ai's ApprovalGate but takes no
 * agent_run_id — chat-driven proposals don't run through AgentRunner;
 * they're a direct user → approval queue path.
 *
 * Validates the action via the ActionDescriptor union before insert
 * so a malformed payload from the model can't produce a poisoned
 * approval row.
 */
export async function insertChatApproval(
  action: ActionDescriptorT,
  source: { userId: string; threadId?: string },
): Promise<{
  id: string;
  actionType: string;
  createdAt: Date;
}> {
  // Re-validate via the union — guards against malformed model output.
  const parsed = ActionDescriptor.parse(action);

  const id = createId();
  const now = new Date();

  const [row] = await db
    .insert(approvals)
    .values({
      id,
      agentRunId: null,
      actionType: parsed.kind,
      proposedPayload: parsed as unknown as Record<string, unknown>,
      decision: 'pending',
    })
    .returning({
      id: approvals.id,
      actionType: approvals.actionType,
      createdAt: approvals.createdAt,
    });

  if (!row) {
    throw new Error(`approval ${id} insert returned no row`);
  }

  await db
    .insert(events)
    .values({
      id: createId(),
      verb: 'approval.created',
      subjectType: 'approval',
      subjectId: row.id,
      actorType: 'user',
      actorId: source.userId,
      objectType: 'approval',
      objectId: row.id,
      occurredAt: now,
      idempotencyKey: `approval.created:${row.id}`,
      metadata: {
        action_type: parsed.kind,
        tier: parsed.tier,
        source: 'chat',
        ...(source.threadId ? { thread_id: source.threadId } : {}),
      },
    })
    .onConflictDoNothing({
      target: [events.occurredAt, events.idempotencyKey],
    });

  // Outreach feature snapshot — captured here at proposal time so
  // the LightGBM reply-14d classifier trains on the same signals
  // the operator saw when approving. Limited to the four outreach
  // action types; other actions (sanctions screens, follow-ups,
  // milestones) aren't ranked. Errors swallowed inside the
  // helpers — a feature-snapshot failure must never block the
  // approval write itself.
  if (
    parsed.kind === 'email.send' ||
    parsed.kind === 'sms.send' ||
    parsed.kind === 'whatsapp.send' ||
    parsed.kind === 'whatsapp.send_template' ||
    parsed.kind === 'outbound_call'
  ) {
    try {
      const features = await buildOutreachFeatures({
        approvalId: row.id,
        proposedPayload: parsed as unknown as Record<string, unknown>,
      });
      await recordOutreachFeatureSnapshot({
        approvalId: row.id,
        features,
      });
    } catch (err) {
      console.error('[outreach-features] hook failed', err);
    }
  }

  return row;
}
