import type { ActionDescriptorT } from './action-descriptor';
import type { CostLedger } from '../cost-ledger';

/**
 * What an agent receives. Lighter than vex's AgentContext — procur
 * doesn't carry the per-tenant repository bag (single-user scoping per
 * Phase 0); agents access the DB through @procur/catalog query helpers.
 *
 * Per-agent extras (Anthropic client, retrieval service, etc.) live on
 * subclass-extended contexts; AgentRunner only owns this base shape.
 */
export interface AgentContext {
  /** ULID of the agent_runs row this invocation owns. */
  agentRunId: string;
  /** Cost ledger writer — every chargeable operation records here. */
  costLedger: CostLedger;
  /** UTC clock — injected so tests can pin time. */
  now: () => Date;
}

/**
 * Output returned by an agent's `run()` method. T2+ proposed actions in
 * `proposedActions` are routed through ApprovalGate by AgentRunner;
 * `internalWrites` is a count for the audit trail of agent_runs.outputRefs.
 */
export interface AgentOutput {
  proposedActions: ActionDescriptorT[];
  /** Count of immediate side-effects the agent applied (T0/T1 writes). */
  internalWrites: number;
  /** Total USD cost of this run — populated from the cost ledger. */
  costUsd: number;
  /** Free-form structured output for the agent_runs.output_refs column. */
  outputRefs?: Record<string, unknown>;
  /** One-line summary surfaced in the agent_runs list. */
  rationale?: string;
}

export interface IAgent {
  /** Stable machine name. Stored in agent_runs.agent_name. */
  readonly name: string;
  /** Tier the agent itself runs at. T0 agents bypass the cost gate. */
  readonly tier: 'T0' | 'T1' | 'T2' | 'T3';
  run(ctx: AgentContext): Promise<AgentOutput>;
}
