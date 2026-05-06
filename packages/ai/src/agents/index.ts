/**
 * Agent runtime — vex-into-procur merge Phase 2.
 * Per docs/vex-into-procur-merge-brief.md.
 *
 * Public surface:
 *   - ActionDescriptor: typed Zod union of every agent-proposable action
 *   - ApprovalTier: T0/T1/T2/T3 + requiresApproval helper
 *   - ApprovalGate: writes approval rows for T2+ actions
 *   - AgentRunner: orchestrator wrapping agent.run() with cost gate +
 *     approval routing + audit events
 *   - createId / isUlid: ULID generators (text PKs for vex-imported tables)
 */

export {
  ActionDescriptor,
  actionRequiresApproval,
  type ActionDescriptorT,
} from './action-descriptor';
export { ApprovalTier, requiresApproval } from './approval-tier';
export { ApprovalGate } from './approval-gate';
export {
  AgentRunner,
  DEFAULT_DAILY_COST_LIMIT_USD,
  type AgentRunRecord,
  type AgentRunnerOptions,
} from './agent-runner';
export type { AgentContext, AgentOutput, IAgent } from './types';
export { createId, isUlid } from './id';
export {
  EmailReplyDraftAgent,
  type EmailReplyDraftInput,
} from './agents/email-reply-draft';
export {
  DealEvaluatorAgent,
  type DealEvaluatorInput,
} from './agents/deal-evaluator';
export {
  DealMarketContextAgent,
  type DealMarketContextDeps,
  type DealMarketContextInput,
  type EvaluateTargetPriceFn,
} from './agents/deal-market-context';
// Phase 6 — sanctions screening + daily brief
export {
  SanctionsScreeningAgent,
  type SanctionsScreeningInput,
} from './agents/sanctions-screening';
export {
  DailyBriefAgent,
  type DailyBrief,
  type DailyBriefInput,
} from './agents/daily-brief';
