/**
 * Approval tiers ported from vex's @vex/domain. Per the agent-runtime
 * invariant: T2+ actions NEVER execute inline — they land in the
 * `approvals` table with a typed `proposed_payload` and a human (or
 * auto-approval rule) decides later.
 *
 *  - T0: read-only / observation — runs without recording an approval
 *  - T1: low-risk side-effect (log, tag, milestone) — the agent runner
 *        records it in agent_runs.outputRefs but doesn't gate on approval
 *  - T2: meaningful side-effect (email send, contact patch, deal create) —
 *        gated, requires explicit operator approval
 *  - T3: high-risk / hard-to-reverse (lead close, voice call, deal
 *        rejection) — gated, must be approved one at a time, never
 *        eligible for auto-approval rules
 */
export const ApprovalTier = {
  T0: 'T0',
  T1: 'T1',
  T2: 'T2',
  T3: 'T3',
} as const;

export type ApprovalTier = (typeof ApprovalTier)[keyof typeof ApprovalTier];

/**
 * Returns true iff executing the action requires a decided-approved
 * approval row. Mirrors vex's @vex/domain `requiresApproval`.
 */
export function requiresApproval(tier: ApprovalTier): boolean {
  return tier === ApprovalTier.T2 || tier === ApprovalTier.T3;
}
