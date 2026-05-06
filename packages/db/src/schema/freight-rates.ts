import {
  date,
  doublePrecision,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { vesselClassEnum } from './enums';

/**
 * Per docs/vex-into-procur-merge-brief.md Phase 5. Time-series of
 * market freight benchmarks keyed on (origin, destination,
 * vessel_class, product_category, source). Populated from Baltic /
 * Platts / broker circulars / manual entries; consumed by the deal
 * evaluator to mark-to-market every locked freight rate.
 *
 * Region slugs and product_category are free text so new lanes /
 * categories can be added without a schema bump.
 */
export const freightRates = pgTable(
  'freight_rates',
  {
    id: text('id').primaryKey(),
    rateDate: date('rate_date').notNull(),
    originRegion: text('origin_region').notNull(),
    destinationRegion: text('destination_region').notNull(),
    vesselClass: vesselClassEnum('vessel_class').notNull(),
    /** "clean_products" | "dirty" | "dry_bulk" | ... */
    productCategory: text('product_category').notNull(),
    rateUsdPerMt: doublePrecision('rate_usd_per_mt').notNull(),
    /** Worldscale points for tanker voyage charters; null when source
     *  quotes a fixed $/mt only. */
    worldscalePoints: doublePrecision('worldscale_points'),
    /** "baltic" | "platts" | "broker_circular" | "manual". */
    source: text('source').notNull(),
    sourceReference: text('source_reference'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    routeIdx: index('freight_rates_route_idx').on(
      t.originRegion,
      t.destinationRegion,
      t.vesselClass,
      t.rateDate,
    ),
    uniqRow: uniqueIndex('freight_rates_uniq').on(
      t.rateDate,
      t.originRegion,
      t.destinationRegion,
      t.vesselClass,
      t.productCategory,
      t.source,
    ),
  }),
);

export type FreightRate = typeof freightRates.$inferSelect;
export type NewFreightRate = typeof freightRates.$inferInsert;
