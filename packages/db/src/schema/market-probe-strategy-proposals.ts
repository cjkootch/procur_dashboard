import {
  pgTable,
  text,
  jsonb,
  timestamp,
  index,
} from 'drizzle-orm/pg-core';
import { marketProbes } from './market-probes';

/**
 * Strategy proposals (migration 0096). Agent-proposed plan changes
 * the operator approves/rejects. Approved proposals modify
 * `market_probes.plan_json` + advance the probe; rejected proposals
 * carry forward as constraints into the next plan-generation pass —
 * both directions are training signal.
 *
 * Discipline: the agent NEVER mutates the probe plan directly. It
 * writes to this table; operator reviews; only operator approval
 * applies the change. Same propose-only pattern as the existing
 * `propose_*` chat tools.
 */
export const marketProbeStrategyProposals = pgTable(
  'market_probe_strategy_proposals',
  {
    id: text('id').primaryKey(),
    probeId: text('probe_id')
      .notNull()
      .references(() => marketProbes.id, { onDelete: 'cascade' }),

    /** Free text. Canonical values:
     *    shift_segment | add_segment | pause_segment |
     *    change_template | tighten_targeting | loosen_targeting |
     *    shift_titles | pause_probe | complete_probe */
    proposalType: text('proposal_type').notNull(),

    rationale: text('rationale').notNull(),

    /** Structured before/after snapshot of the affected fields. UI
     *  renders as a diff; executor applies on approve. */
    payloadJson: jsonb('payload_json')
      .$type<StrategyProposalPayload>()
      .notNull()
      .default({} as StrategyProposalPayload),

    /** Metric snapshot at proposal time — what evidence drove this. */
    evidenceJson: jsonb('evidence_json')
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),

    /** proposed | approved | rejected | superseded. */
    status: text('status').notNull().default('proposed'),

    /** Operator notes when rejecting. Crucial: rides into next plan-
     *  generation pass as a constraint so the agent learns. */
    reviewerFeedback: text('reviewer_feedback'),

    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    reviewedByUserId: text('reviewed_by_user_id'),
    appliedAt: timestamp('applied_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    probeIdx: index('market_probe_strategy_proposals_probe_idx').on(
      t.probeId,
    ),
    statusIdx: index('market_probe_strategy_proposals_status_idx').on(
      t.status,
    ),
    probeStatusIdx: index(
      'market_probe_strategy_proposals_probe_status_idx',
    ).on(t.probeId, t.status),
  }),
);

export type MarketProbeStrategyProposal =
  typeof marketProbeStrategyProposals.$inferSelect;
export type NewMarketProbeStrategyProposal =
  typeof marketProbeStrategyProposals.$inferInsert;

/**
 * Payload shape — discriminated by proposal_type. The before/after
 * structure is consistent so the UI diff renderer doesn't branch
 * per type.
 */
export interface StrategyProposalPayload {
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  /** Optional human-readable summary the agent emits alongside the
   *  structured diff — falls back to rationale when absent. */
  summary?: string;
}
