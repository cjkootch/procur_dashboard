import {
  pgTable,
  serial,
  text,
  numeric,
  date,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

/**
 * Daily commodity price observations. One row per
 * (series_slug, contract_type, price_date).
 *
 * Series are keyed by a stable slug:
 *   - 'brent', 'wti', 'dubai', 'urals'   — crude marker grades
 *   - 'usgc-diesel', 'usgc-gasoline'      — US Gulf Coast wholesale spot
 *   - 'nyh-heating-oil'                   — NY Harbor heating oil
 * Slugs match crude_grades.slug where the price covers a known grade
 * (so a join surfaces "Brent at 82.40 today" alongside grade properties).
 *
 * Source attribution stored verbatim:
 *   - 'fred'  — FRED CSV (St Louis Fed). No API key. Brent + WTI daily.
 *   - 'eia'   — US EIA API. Free key required (EIA_API_KEY). Refined.
 *   - 'opec'  — OPEC monthly basket (CSV). Future.
 *
 * Public-domain. No companyId scoping — same as awards / customs.
 */
export const commodityPrices = pgTable(
  'commodity_prices',
  {
    id: serial('id').primaryKey(),

    /** Stable identifier — e.g. 'brent', 'wti', 'usgc-diesel'. */
    seriesSlug: text('series_slug').notNull(),

    /** 'spot' (default) | 'forward-1m' | 'forward-3m'. Most series ingested
        today are spot; placeholder for future forward-curve work. */
    contractType: text('contract_type').notNull().default('spot'),

    /** 'fred' | 'eia' | 'opec'. */
    source: text('source').notNull(),

    /** Date the price applies to (NOT the ingest date). */
    priceDate: date('price_date').notNull(),

    /** Price value. Unit determined by `unit` column. */
    price: numeric('price').notNull(),

    /** 'usd-bbl' for crude (default). 'usd-gal' for refined products
        published per gallon (US-style). 'usd-mt' for products quoted
        per metric ton (European-style). */
    unit: text('unit').notNull().default('usd-bbl'),

    /** Source-specific extras (FRED series id, EIA series id). */
    metadata: jsonb('metadata'),

    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => ({
    uniq: uniqueIndex('commodity_prices_uniq_idx').on(
      table.seriesSlug,
      table.contractType,
      table.priceDate,
    ),
    seriesDateIdx: index('commodity_prices_series_date_idx').on(
      table.seriesSlug,
      table.priceDate,
    ),
  }),
);

export type CommodityPrice = typeof commodityPrices.$inferSelect;
export type NewCommodityPrice = typeof commodityPrices.$inferInsert;
