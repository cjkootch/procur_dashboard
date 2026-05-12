import {
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * FAS Open Data country reference cache. FAS uses its own 2-char
 * country code system that does not strictly align with ISO-2
 * (e.g. CH = China, not Switzerland). Populated on ingest from
 * /api/esr/countries + /api/gats/countries; the manually-curated
 * `iso2` column maps the seed countries we actually ingest.
 *
 * Source: https://apps.fas.usda.gov/opendatawebV2/assets/swagger/swagger.json
 */
export const fasCountries = pgTable(
  'fas_countries',
  {
    fasCode: text('fas_code').notNull(),
    api: text('api').notNull(), // 'esr' | 'gats' | 'psd'
    countryName: text('country_name').notNull(),
    regionCode: text('region_code'),
    iso2: text('iso2'),
    rawPayload: jsonb('raw_payload'),
    ingestedAt: timestamp('ingested_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.fasCode, table.api] }),
    iso2Idx: index('fas_countries_iso2_idx').on(table.iso2),
  }),
);

export type FasCountry = typeof fasCountries.$inferSelect;
export type NewFasCountry = typeof fasCountries.$inferInsert;

/**
 * ESR (Export Sales Reporting) weekly observations. US-export
 * specific: reporter is always the US, partner is `countryCode`. One
 * row per (commodity_code, country_code, market_year, week_ending).
 *
 * The 8 numeric columns are the ESR record's standard fields:
 *  - weeklyExports: actual physical exports shipped this week
 *  - accumulatedExportsMarketYr: total shipped MY-to-date
 *  - outstandingSales: open contracts not yet shipped
 *  - grossNewSales: new sales this week (before cancellations)
 *  - currentMyTotalCommitment: accumulated + outstanding for current MY
 *  - currentMyNetSales: net new commitments this week (sales - cancellations)
 *  - nextMyOutstandingSales / nextMyNetSales: same for the next MY
 *    (advance bookings)
 *
 * Units vary by commodity (wheat/corn in MT, beef in MT, soy oil in
 * MT, etc.) — uom_id is the FAS-published unit code.
 *
 * Source: https://api.fas.usda.gov/api/esr/exports/...
 */
export const fasEsrWeekly = pgTable(
  'fas_esr_weekly',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    commodityCode: integer('commodity_code').notNull(),
    countryCode: text('country_code').notNull(),
    marketYear: integer('market_year').notNull(),
    weekEndingDate: date('week_ending_date').notNull(),

    weeklyExports: numeric('weekly_exports', { precision: 20, scale: 2 }),
    accumulatedExportsMarketYr: numeric('accumulated_exports_market_yr', {
      precision: 20,
      scale: 2,
    }),
    outstandingSales: numeric('outstanding_sales', { precision: 20, scale: 2 }),
    grossNewSales: numeric('gross_new_sales', { precision: 20, scale: 2 }),
    currentMyTotalCommitment: numeric('current_my_total_commitment', {
      precision: 20,
      scale: 2,
    }),
    currentMyNetSales: numeric('current_my_net_sales', { precision: 20, scale: 2 }),
    nextMyOutstandingSales: numeric('next_my_outstanding_sales', {
      precision: 20,
      scale: 2,
    }),
    nextMyNetSales: numeric('next_my_net_sales', { precision: 20, scale: 2 }),

    uomId: integer('uom_id'),

    rawPayload: jsonb('raw_payload'),
    ingestedAt: timestamp('ingested_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => ({
    uniq: uniqueIndex('fas_esr_weekly_uniq').on(
      table.commodityCode,
      table.countryCode,
      table.marketYear,
      table.weekEndingDate,
    ),
    countryCommodityIdx: index('fas_esr_weekly_country_commodity_idx').on(
      table.countryCode,
      table.commodityCode,
      table.weekEndingDate,
    ),
    weekEndingIdx: index('fas_esr_weekly_week_ending_idx').on(
      table.weekEndingDate,
    ),
  }),
);

export type FasEsrWeekly = typeof fasEsrWeekly.$inferSelect;
export type NewFasEsrWeekly = typeof fasEsrWeekly.$inferInsert;

/**
 * FAS commodity reference cache. Populated by ingest-fas-esr from
 * /api/esr/commodities. Required for chat tools to return
 * human-readable commodity names alongside FAS commodity codes —
 * "wheat" / "soybean meal" / "muscle cuts of pork" rather than
 * 401 / 107 / 1505.
 */
export const fasCommodities = pgTable(
  'fas_commodities',
  {
    commodityCode: integer('commodity_code').notNull(),
    api: text('api').notNull(),
    commodityName: text('commodity_name').notNull(),
    unitId: integer('unit_id'),
    rawPayload: jsonb('raw_payload'),
    ingestedAt: timestamp('ingested_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.commodityCode, table.api] }),
  }),
);

export type FasCommodity = typeof fasCommodities.$inferSelect;
export type NewFasCommodity = typeof fasCommodities.$inferInsert;
