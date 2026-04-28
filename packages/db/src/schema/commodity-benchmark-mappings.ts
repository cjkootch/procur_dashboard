import {
  pgTable,
  uuid,
  text,
  numeric,
  timestamp,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';

/**
 * Maps internal taxonomy (category × country × grade) to a specific
 * commodity_prices series. Used by award_price_deltas (Phase 2 MV) to
 * resolve the right benchmark for each award.
 *
 * Granularity: category + country + grade. Multiple rows per category
 * are common (one per country, one per grade variant). When the
 * award's grade is unknown, resolution falls through:
 *   1. exact: category + country + grade
 *   2. country default: category + country + NULL grade
 *   3. global default: category + 'GLOBAL' + NULL grade
 *
 * Public-domain. No tenant scoping.
 */
export const commodityBenchmarkMappings = pgTable(
  'commodity_benchmark_mappings',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /** Internal category tag — matches awards.category_tags vocabulary. */
    categoryTag: text('category_tag').notNull(),
    /** ISO-2 country code, or 'GLOBAL' for catch-all. */
    countryCode: text('country_code').notNull(),
    /** Grade specifier. NULL = country default for the category.
        Examples: 'ulsd_50ppm', 'ulsd_500ppm', 'rbob_87', 'rbob_93',
        'jet_a1', 'hfo_380cst', 'lpg_propane'. */
    grade: text('grade'),

    /** References commodity_prices.series_slug. */
    benchmarkSlug: text('benchmark_slug').notNull(),
    /** commodity_prices.source that owns this slug. 'fred' | 'eia'. */
    benchmarkSource: text('benchmark_source').notNull(),
    /** Adjustment in $/bbl applied on top of the benchmark before
        delta computation. Useful when the benchmark is a known proxy
        with a stable offset (e.g. RBOB 87 vs 93 has ~$8/bbl spread). */
    benchmarkAdjustmentUsdBbl: numeric('benchmark_adjustment_usd_bbl', {
      precision: 8,
      scale: 4,
    }),

    /** Free-text rationale — useful when revisiting mappings. */
    notes: text('notes'),

    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => ({
    lookupUniq: uniqueIndex('commodity_benchmark_mappings_uniq_idx').on(
      table.categoryTag,
      table.countryCode,
      table.grade,
    ),
    categoryIdx: index('commodity_benchmark_mappings_category_idx').on(
      table.categoryTag,
    ),
  }),
);

export type CommodityBenchmarkMapping = typeof commodityBenchmarkMappings.$inferSelect;
export type NewCommodityBenchmarkMapping = typeof commodityBenchmarkMappings.$inferInsert;
