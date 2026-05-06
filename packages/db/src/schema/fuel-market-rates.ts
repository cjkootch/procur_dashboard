import {
  date,
  doublePrecision,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

/**
 * Per docs/vex-into-procur-merge-brief.md Phase 5. Reference rates
 * for pricing and benchmarking. All three per-unit prices stored so
 * downstream consumers don't re-derive. Unique on (rate_date, product,
 * benchmark) for idempotent re-ingest.
 */
export const fuelMarketRates = pgTable(
  'fuel_market_rates',
  {
    id: text('id').primaryKey(),
    rateDate: date('rate_date').notNull(),
    product: text('product').notNull(),
    benchmark: text('benchmark').notNull(),
    pricePerUsg: doublePrecision('price_per_usg').notNull(),
    pricePerBbl: doublePrecision('price_per_bbl').notNull(),
    pricePerMt: doublePrecision('price_per_mt').notNull(),
    currency: text('currency').notNull().default('usd'),
    source: text('source').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    productBenchmarkIdx: index('fuel_market_rates_product_benchmark_idx').on(
      t.product,
      t.benchmark,
    ),
    dateIdx: index('fuel_market_rates_date_idx').on(t.rateDate),
    uniqPerDay: uniqueIndex('fuel_market_rates_uniq_per_day').on(
      t.rateDate,
      t.product,
      t.benchmark,
    ),
  }),
);

export type FuelMarketRate = typeof fuelMarketRates.$inferSelect;
export type NewFuelMarketRate = typeof fuelMarketRates.$inferInsert;
