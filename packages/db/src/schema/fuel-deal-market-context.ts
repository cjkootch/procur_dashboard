import {
  doublePrecision,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { fuelDeals } from './fuel-deals';

/**
 * Per docs/vex-into-procur-merge-brief.md Phase 5. Procur-sourced
 * market context for a fuel deal. Populated by DealMarketContextAgent
 * on draft→live (or on operator-triggered re-evaluation). One row
 * per deal — idempotent on re-run via the unique index. Distinct from
 * `fuel_market_rates` (operator-managed pricing references) — this
 * table is empirically derived from procur's award_price_deltas
 * distribution.
 */
export const fuelDealMarketContext = pgTable(
  'fuel_deal_market_context',
  {
    id: text('id').primaryKey(),
    dealId: text('deal_id')
      .notNull()
      .references(() => fuelDeals.id, { onDelete: 'cascade' }),

    /** Benchmark anchor: e.g. nyh_ulsd, argus_diesel_carib. */
    benchmarkCode: text('benchmark_code').notNull(),
    benchmarkSpotUsd: doublePrecision('benchmark_spot_usd'),
    /** Spot adjusted for buyer-country premium pattern. */
    effectiveBenchmarkUsd: doublePrecision('effective_benchmark_usd'),

    offerDeltaUsd: doublePrecision('offer_delta_usd'),
    offerDeltaPct: doublePrecision('offer_delta_pct'),

    historicalMeanDeltaPct: doublePrecision('historical_mean_delta_pct'),
    historicalMedianDeltaPct: doublePrecision('historical_median_delta_pct'),
    historicalStddevDeltaPct: doublePrecision('historical_stddev_delta_pct'),
    historicalSampleSize: integer('historical_sample_size'),

    /** Z-score in the historical distribution. Positive = above-typical
     *  premium (high), negative = aggressive (possibly distress). */
    zScore: doublePrecision('z_score'),
    /** Percentile rank, 0-100. */
    percentile: doublePrecision('percentile'),
    /** aggressive | competitive | fair | high | outlier_high. */
    verdict: text('verdict').notNull(),
    rationale: text('rationale'),

    fetchedAt: timestamp('fetched_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    verdictIdx: index('fuel_deal_market_context_verdict_idx').on(t.verdict),
    /** One row per deal — re-evaluation upserts on this conflict target. */
    dealUnique: uniqueIndex('fuel_deal_market_context_deal_unique').on(
      t.dealId,
    ),
  }),
);

export type FuelDealMarketContext = typeof fuelDealMarketContext.$inferSelect;
export type NewFuelDealMarketContext =
  typeof fuelDealMarketContext.$inferInsert;
