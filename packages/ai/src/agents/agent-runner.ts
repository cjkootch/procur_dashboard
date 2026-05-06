import { db, agentRuns, events } from '@procur/db';
import { eq } from 'drizzle-orm';
import { ApprovalGate } from './approval-gate';
import { createId } from './id';
import { sumCostLedgerToday } from '../cost-ledger';
import type { CostLedger } from '../cost-ledger';
import type { AgentContext, AgentOutput, IAgent } from './types';

/** What `run()` returns to the caller. Mirrors vex's AgentRunRecord. */
export interface AgentRunRecord {
  agentRunId: string | null;
  status:
    | 'skipped_kill_switch'
    | 'skipped_cost_limit'
    | 'completed'
    | 'failed';
  costUsd: number;
  approvalsCreated: number;
  internalWrites: number;
  rationale?: string;
  error?: string;
  outputRefs?: Record<string, unknown>;
}

/**
 * Default daily cost ceiling when nothing else overrides. Matches the
 * vex Sprint 9 spec ($5/day). Override via the `dailyCostLimitUsd`
 * constructor option for per-environment tuning.
 */
export const DEFAULT_DAILY_COST_LIMIT_USD = 5;

export interface AgentRunnerOptions {
  costLedger: CostLedger;
  /** Global kill switch — when true, all T1+ agents are skipped. */
  killSwitch?: boolean;
  /** Override the default daily cost cap (USD). */
  dailyCostLimitUsd?: number;
  /** Injected for tests; production uses `() => new Date()`. */
  now?: () => Date;
}

/**
 * Orchestrates a single agent invocation. Per docs/vex-into-procur-merge-brief.md
 * Phase 2 — ports vex's AgentRunner pattern onto procur, lighter than the
 * vex original (procur drops vex's per-tenant repository bag because
 * Phase 0 locked single-user scoping; agents access the DB through
 * @procur/catalog query helpers or direct drizzle calls).
 *
 * Lifecycle:
 *   1. Pre-check kill switch — T1+ skipped when on
 *   2. Pre-check daily cost gate via cost_ledger sum
 *   3. Insert agent_runs row (status=pending → running)
 *   4. Call agent.run(ctx) inside try/catch
 *   5. Route T2+ proposed actions through ApprovalGate
 *   6. Mark agent_runs.complete, emit audit events
 */
export class AgentRunner {
  private readonly gate = new ApprovalGate();
  private readonly costLedger: CostLedger;
  private readonly killSwitch: boolean;
  private readonly dailyCostLimitUsd: number;
  private readonly now: () => Date;

  constructor(options: AgentRunnerOptions) {
    this.costLedger = options.costLedger;
    this.killSwitch = options.killSwitch ?? false;
    this.dailyCostLimitUsd =
      options.dailyCostLimitUsd ?? DEFAULT_DAILY_COST_LIMIT_USD;
    this.now = options.now ?? (() => new Date());
  }

  async run(agent: IAgent): Promise<AgentRunRecord> {
    if (this.killSwitch && agent.tier !== 'T0') {
      return {
        agentRunId: null,
        status: 'skipped_kill_switch',
        costUsd: 0,
        approvalsCreated: 0,
        internalWrites: 0,
        rationale: `kill switch on; ${agent.name} is ${agent.tier}`,
      };
    }

    if (agent.tier !== 'T0') {
      const gateResult = await this.checkCostGate();
      if (gateResult.skipped) {
        return {
          agentRunId: null,
          status: 'skipped_cost_limit',
          costUsd: 0,
          approvalsCreated: 0,
          internalWrites: 0,
          rationale: gateResult.reason ?? 'daily cost cap reached',
        };
      }
    }

    const agentRunId = createId();
    await db.insert(agentRuns).values({
      id: agentRunId,
      agentName: agent.name,
      status: 'pending',
      inputRefs: {},
    });
    await db
      .update(agentRuns)
      .set({ status: 'running', startedAt: this.now() })
      .where(eq(agentRuns.id, agentRunId));

    const ctx: AgentContext = {
      agentRunId,
      costLedger: this.costLedger,
      now: this.now,
    };

    let output: AgentOutput;
    try {
      output = await agent.run(ctx);
    } catch (err) {
      const message = (err as Error).message ?? 'unknown agent failure';
      await db
        .update(agentRuns)
        .set({
          status: 'failed',
          error: message,
          finishedAt: this.now(),
        })
        .where(eq(agentRuns.id, agentRunId));
      await this.emitAudit(agent, agentRunId, 'agent.failed', {
        error: message,
      });
      return {
        agentRunId,
        status: 'failed',
        costUsd: 0,
        approvalsCreated: 0,
        internalWrites: 0,
        error: message,
      };
    }

    let approvalsCreated = 0;
    const gatedRefs: { approval_id: string; kind: string; tier: string }[] =
      [];
    for (const action of output.proposedActions) {
      if (action.tier === 'T2' || action.tier === 'T3') {
        const approval = await this.gate.create(action, agentRunId);
        approvalsCreated += 1;
        gatedRefs.push({
          approval_id: approval.id,
          kind: action.kind,
          tier: action.tier,
        });
      }
    }

    await db
      .update(agentRuns)
      .set({
        status: 'completed',
        costUsd: output.costUsd,
        outputRefs: {
          ...(output.outputRefs ?? {}),
          approvals: gatedRefs,
          internal_writes: output.internalWrites,
        },
        finishedAt: this.now(),
      })
      .where(eq(agentRuns.id, agentRunId));

    await this.emitAudit(agent, agentRunId, 'agent.completed', {
      cost_usd: output.costUsd,
      approvals_created: approvalsCreated,
      internal_writes: output.internalWrites,
    });

    return {
      agentRunId,
      status: 'completed',
      costUsd: output.costUsd,
      approvalsCreated,
      internalWrites: output.internalWrites,
      ...(output.outputRefs ? { outputRefs: output.outputRefs } : {}),
      ...(output.rationale !== undefined
        ? { rationale: output.rationale }
        : {}),
    };
  }

  /**
   * Pre-run cost gate. Reads today's cost from cost_ledger; if today's
   * spend is at or above the daily cap, the run is skipped. Fails open
   * on query errors — a missing/broken ledger MUST NEVER block agents.
   */
  private async checkCostGate(): Promise<{
    skipped: boolean;
    reason?: string;
  }> {
    let micros: number;
    try {
      micros = await sumCostLedgerToday(this.now());
    } catch {
      return { skipped: false };
    }
    const spentUsd = micros / 1_000_000;
    if (spentUsd >= this.dailyCostLimitUsd) {
      return {
        skipped: true,
        reason: `daily cost limit reached: $${spentUsd.toFixed(2)} spent, cap $${this.dailyCostLimitUsd.toFixed(2)}`,
      };
    }
    return { skipped: false };
  }

  private async emitAudit(
    agent: IAgent,
    agentRunId: string,
    verb: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await db
      .insert(events)
      .values({
        id: createId(),
        verb,
        subjectType: 'agent_run',
        subjectId: agentRunId,
        actorType: 'system',
        actorId: agent.name,
        objectType: 'agent',
        objectId: agent.name,
        occurredAt: this.now(),
        idempotencyKey: `${verb}:${agentRunId}`,
        metadata,
      })
      .onConflictDoNothing({
        target: [events.occurredAt, events.idempotencyKey],
      });
  }
}
