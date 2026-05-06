import { index, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { approvalDecisionEnum } from './enums';
import { agentRuns } from './agent-runs';

/**
 * Per docs/vex-into-procur-merge-brief.md Phase 2. T2+ actions MUST
 * NOT execute without an approval row whose `decision` is `approved`
 * (or `auto_approved` for whitelisted automation). `proposed_payload`
 * captures the typed ActionDescriptor verbatim so reviewers see
 * exactly what they're approving. `applied_object_id` short-circuits
 * retries — if set, the action already ran successfully.
 */
export const approvals = pgTable(
  'approvals',
  {
    id: text('id').primaryKey(),
    agentRunId: text('agent_run_id').references(() => agentRuns.id, {
      onDelete: 'set null',
    }),
    actionType: text('action_type').notNull(),
    proposedPayload: jsonb('proposed_payload')
      .$type<Record<string, unknown>>()
      .notNull(),
    /** Procur user id (text) — no FK because procur users.id is uuid;
     *  Phase 2 will tighten if needed. */
    reviewerId: text('reviewer_id'),
    decision: approvalDecisionEnum('decision').notNull().default('pending'),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    appliedObjectId: text('applied_object_id'),
    appliedAt: timestamp('applied_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    statusIdx: index('approvals_decision_idx').on(t.decision),
    agentRunIdx: index('approvals_agent_run_idx').on(t.agentRunId),
  }),
);

export type Approval = typeof approvals.$inferSelect;
export type NewApproval = typeof approvals.$inferInsert;
