import {
  pgTable,
  text,
  numeric,
  timestamp,
  index,
} from 'drizzle-orm/pg-core';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';

/**
 * Market atlas (migration 0096). Cross-probe memory of market
 * STRUCTURE — gatekeepers, dead ends, referrals, signal quality,
 * compliance quirks. Operators write facts inline as they discover
 * them; the agent writes facts as it observes patterns.
 *
 * Distinct from `entity_dispositions` (Pattern 4 — operator's call on
 * a SINGLE entity) and from `feedback_events` (UI feedback). Atlas
 * facts are about the MARKET — relationships, patterns, learnings —
 * and persist across probes so the next Caribbean food probe doesn't
 * relearn what the previous one discovered.
 *
 * Append-only via superseded_by: when understanding improves, write
 * a new fact and point the old at the new one. Cross-probe queries
 * default to `superseded_by IS NULL`.
 */
export const marketAtlasFacts = pgTable(
  'market_atlas_facts',
  {
    id: text('id').primaryKey(),
    /** ISO-2 country (or 'XX' for cross-border). */
    country: text('country').notNull(),
    /** Optional segment scope — null = market-wide. */
    segment: text('segment'),

    /** Anchor entity (known_entities.slug or external_suppliers.id).
     *  Null for market-level facts ("this market lacks online
     *  procurement infrastructure"). */
    entitySlug: text('entity_slug'),
    /** For relational facts (referral, gatekeeper-of, etc.). */
    relatedEntitySlug: text('related_entity_slug'),

    /** Free text — see migration for the canonical taxonomy:
     *  gatekeeper / bottleneck / dead_end / referral / relationship /
     *  signal_mattered / signal_noise / assumption_wrong /
     *  procurement_pattern / compliance_note */
    factType: text('fact_type').notNull(),

    description: text('description').notNull(),

    /** Prescriptive rule (migration 0097). Pairs with
     *  fact_type='negative_rule' or 'procurement_pattern' — turns the
     *  descriptive fact into a reusable behavioral constraint
     *  ("never target this segment without X qualifier"). Optional;
     *  most fact types leave it null. */
    ruleText: text('rule_text'),

    /** Source pointers. All optional — operator can write standalone. */
    sourceProbeId: text('source_probe_id'),
    sourceTargetId: text('source_target_id'),
    sourceEventId: text('source_event_id'),

    /** 'operator' | 'agent'. Agent-written facts default to lower
     *  confidence and surface as proposals the operator can correct. */
    authoredBy: text('authored_by').notNull().default('operator'),
    confidence: numeric('confidence').notNull().default('0.9'),

    /** Append-only revisions. Self-FK; cross-probe queries filter
     *  superseded_by IS NULL. ON DELETE SET NULL so deleting a
     *  superseder doesn't cascade-orphan history. */
    supersededBy: text('superseded_by').references(
      (): AnyPgColumn => marketAtlasFacts.id,
      { onDelete: 'set null' },
    ),

    createdByUserId: text('created_by_user_id'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    countryIdx: index('market_atlas_facts_country_idx').on(t.country),
    countrySegmentIdx: index('market_atlas_facts_country_segment_idx').on(
      t.country,
      t.segment,
    ),
    entityIdx: index('market_atlas_facts_entity_idx').on(t.entitySlug),
    probeIdx: index('market_atlas_facts_probe_idx').on(t.sourceProbeId),
  }),
);

export type MarketAtlasFact = typeof marketAtlasFacts.$inferSelect;
export type NewMarketAtlasFact = typeof marketAtlasFacts.$inferInsert;
