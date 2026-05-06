import 'server-only';
import { and, desc, eq, sql } from 'drizzle-orm';
import {
  agentRuns,
  approvals,
  costLedger,
  db,
  events,
} from '@procur/db';
import { createId } from '@procur/ai';

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
