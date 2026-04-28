import {
  pgTable,
  uuid,
  text,
  numeric,
  date,
  timestamp,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';

/**
 * Daily FX rates against USD. Sourced from ECB historical reference
 * rates (free, daily, going back to 1999). For currencies not on ECB,
 * a fallback ingest via FRED's foreign-exchange series fills the gap.
 *
 * Convention: rate_to_usd = USD per 1 unit of currency_code. So if
 * 60 DOP = 1 USD, the row stores rate_to_usd ≈ 0.01667.
 *
 * Use for converting non-USD award contract values to USD when the
 * source data lacks an explicit USD figure. Replaces the hardcoded
 * monthly rates in backfill-usd.ts (legacy) with daily-resolution data.
 *
 * Public-domain. No tenant scoping.
 */
export const fxRates = pgTable(
  'fx_rates',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /** ISO-4217. */
    currencyCode: text('currency_code').notNull(),
    rateDate: date('rate_date').notNull(),
    /** USD per 1 unit of currency_code. */
    rateToUsd: numeric('rate_to_usd', { precision: 18, scale: 8 }).notNull(),

    /** 'ecb' | 'fred' | 'manual'. */
    source: text('source').notNull(),

    ingestedAt: timestamp('ingested_at').defaultNow().notNull(),
  },
  (table) => ({
    currencyDateUniq: uniqueIndex('fx_rates_currency_date_uniq_idx').on(
      table.currencyCode,
      table.rateDate,
    ),
    dateIdx: index('fx_rates_date_idx').on(table.rateDate),
  }),
);

export type FxRate = typeof fxRates.$inferSelect;
export type NewFxRate = typeof fxRates.$inferInsert;
