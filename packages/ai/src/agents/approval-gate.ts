import { db, approvals, events } from '@procur/db';
import type { ActionDescriptorT } from './action-descriptor';
import { createId } from './id';

/**
 * Centralised gate for T2+ actions. Per the agent-runtime invariant
 * (vex-into-procur merge brief Phase 2): T2+ actions NEVER execute
 * inline — the agent describes what it would do, ApprovalGate writes
 * the approval row, and a human (or auto-approval rule) decides later.
 *
 * Always emits an `approval.created` audit event so the inbox + downstream
 * notifications have a deterministic trigger. The Phase 1 `events` table
 * is partitioned by occurred_at and unique on (occurred_at, idempotency_key)
 * so re-runs of the same agent invocation collapse to one event row.
 *
 * Returns the persisted approval row.
 */
export class ApprovalGate {
  async create(
    action: ActionDescriptorT,
    agentRunId: string,
  ): Promise<{ id: string; actionType: string; createdAt: Date }> {
    const approvalId = createId();
    const now = new Date();

    const [row] = await db
      .insert(approvals)
      .values({
        id: approvalId,
        agentRunId,
        actionType: action.kind,
        proposedPayload: action as unknown as Record<string, unknown>,
        decision: 'pending',
      })
      .returning({
        id: approvals.id,
        actionType: approvals.actionType,
        createdAt: approvals.createdAt,
      });

    if (!row) {
      throw new Error(`approval ${approvalId} insert returned no row`);
    }

    await db
      .insert(events)
      .values({
        id: createId(),
        verb: 'approval.created',
        subjectType: 'approval',
        subjectId: row.id,
        actorType: 'system',
        actorId: agentRunId,
        objectType: 'approval',
        objectId: row.id,
        occurredAt: now,
        idempotencyKey: `approval.created:${row.id}`,
        metadata: {
          action_type: action.kind,
          tier: action.tier,
          agent_run_id: agentRunId,
        },
      })
      .onConflictDoNothing({
        target: [events.occurredAt, events.idempotencyKey],
      });

    return row;
  }
}
