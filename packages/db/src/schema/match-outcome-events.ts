import {
  pgTable,
  uuid,
  text,
  timestamp,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

/**
 * Append-only event log of vex's match-outcome reports.
 *
 * Distinct from `match_queue.deal_outcome` (which carries the LATEST
 * terminal outcome for the operator UI). This table is the canonical
 * history; the match_queue column is a denormalization the
 * `/api/intelligence/match-outcome` route also updates.
 *
 * Idempotent on (procur_opportunity_id, outcome) — re-posting the
 * same pair is a noop. Vex's lifecycle hooks may re-fire (5xx retry,
 * config replay), and we drop duplicates rather than 4xx.
 *
 * `outcome` vocabulary, mirrored at the route layer:
 *   'created'        — vex created a fuel_deal from a procur lead
 *   'closed_won'     — deal settled (VTC realized margin)
 *   'closed_lost'    — deal cancelled / failed
 *   'no_engagement'  — 90+ days, no real conversation (vex emits
 *                       this in a separate background job)
 *
 * See docs/data-graph-connections-brief.md §4 + vex PR #309.
 */
export const matchOutcomeEvents = pgTable(
  'match_outcome_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /** procurOpportunityId == sourceRef the procur push sent vex.
     *  Typical shape: `match-queue:<uuid>` or
     *  `match-queue:<uuid>:<canonical-key>`. Stored verbatim. */
    procurOpportunityId: text('procur_opportunity_id').notNull(),

    /** Validated against MATCH_DEAL_OUTCOMES at the route layer. */
    outcome: text('outcome').notNull(),

    /** Vex's ULID + human-readable ref. Set on outcome='created'
     *  and echoed on terminal outcomes. */
    vexDealId: text('vex_deal_id'),
    vexDealRef: text('vex_deal_ref'),

    /** Free-text rationale captured at the operator's transition. */
    outcomeNote: text('outcome_note'),

    /** When vex observed the transition (vex's clock). Distinct
     *  from `createdAt` (when we received the webhook). */
    reportedAt: timestamp('reported_at', { withTimezone: true }).notNull(),

    /** 'vex' today. Future emitters get their own value. */
    source: text('source').notNull().default('vex'),

    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    dedupIdx: uniqueIndex('match_outcome_events_dedup_idx').on(
      table.procurOpportunityId,
      table.outcome,
    ),
    opportunityIdx: index('match_outcome_events_opportunity_idx').on(
      table.procurOpportunityId,
      table.reportedAt,
    ),
    reportedAtIdx: index('match_outcome_events_reported_at_idx').on(
      table.reportedAt,
    ),
    vexDealIdx: index('match_outcome_events_vex_deal_id_idx').on(table.vexDealId),
  }),
);

export type MatchOutcomeEvent = typeof matchOutcomeEvents.$inferSelect;
export type NewMatchOutcomeEvent = typeof matchOutcomeEvents.$inferInsert;
