import { eq } from 'drizzle-orm';
import { approvals, db, events } from '@procur/db';
import { createId } from '../agents/id';
import { AgentRunner } from '../agents/agent-runner';
import { SanctionsScreeningAgent } from '../agents/agents/sanctions-screening';
import { PostgresCostLedger } from '../cost-ledger';

/**
 * `sanctions.screen` executor — invokes the SanctionsScreeningAgent
 * via AgentRunner so the screen runs through the same lifecycle as
 * any other agent (kill switch, cost gate, agent_runs row, audit
 * events). Idempotent on the approval id; the AgentRunner itself
 * is idempotent enough that re-running produces a fresh agent_runs
 * row but no duplicate sanctions screen because the screening agent
 * dedups on (vexTenantId, screenId).
 */

interface ExecutorResult {
  ok: boolean;
  appliedObjectId?: string;
  error?: string;
}

async function alreadyApplied(approvalId: string): Promise<boolean> {
  const rows = await db
    .select({ appliedAt: approvals.appliedAt })
    .from(approvals)
    .where(eq(approvals.id, approvalId))
    .limit(1);
  return rows[0]?.appliedAt != null;
}

export interface SanctionsScreenPayload {
  organizationId: string;
  rationale: string;
}

export function parseSanctionsScreenPayload(
  proposedPayload: Record<string, unknown> | null | undefined,
): SanctionsScreenPayload | null {
  if (!proposedPayload || typeof proposedPayload !== 'object') return null;
  const organizationId = proposedPayload['organizationId'];
  const rationale = proposedPayload['rationale'];
  if (typeof organizationId !== 'string' || typeof rationale !== 'string') {
    return null;
  }
  return { organizationId, rationale };
}

export async function applySanctionsScreen(
  approvalId: string,
  payload: SanctionsScreenPayload,
): Promise<ExecutorResult> {
  if (await alreadyApplied(approvalId)) return { ok: true };

  const runner = new AgentRunner({ costLedger: new PostgresCostLedger() });
  const agent = new SanctionsScreeningAgent({
    organizationId: payload.organizationId,
  });
  const record = await runner.run(agent);

  if (record.status === 'failed') {
    return { ok: false, error: record.error ?? 'sanctions screen failed' };
  }

  const occurredAt = new Date();
  await db
    .update(approvals)
    .set({
      appliedObjectId: record.agentRunId ?? payload.organizationId,
      appliedAt: occurredAt,
    })
    .where(eq(approvals.id, approvalId));
  await db
    .insert(events)
    .values({
      id: createId(),
      verb: 'sanctions.screen.applied',
      subjectType: 'approval',
      subjectId: approvalId,
      actorType: 'system',
      actorId: 'sanctions-executor',
      objectType: 'agent_run',
      objectId: record.agentRunId ?? payload.organizationId,
      occurredAt,
      idempotencyKey: `sanctions.screen.applied:${approvalId}`,
      metadata: {
        agent_status: record.status,
        ...(record.outputRefs ? { agent_output: record.outputRefs } : {}),
      },
    })
    .onConflictDoNothing({
      target: [events.occurredAt, events.idempotencyKey],
    });

  return {
    ok: true,
    appliedObjectId: record.agentRunId ?? payload.organizationId,
  };
}
