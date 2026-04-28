import {
  pgTable,
  uuid,
  text,
  numeric,
  date,
  timestamp,
  jsonb,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';

/**
 * Customs / external-trade flows. Distinct from `awards` (which are
 * public procurement events) and `known_entities` (which is curated
 * rolodex). This table holds aggregate trade flows — "country X
 * imported N tonnes of product Y from country Z in month M".
 *
 * Data source v1: Eurostat Comext (free, monthly, EU reporters only).
 * Future enrichment: UN Comtrade (global coverage, lagged), country-
 * specific sources (Indian DGCI&S, etc.).
 *
 * One row per (source, reporter, partner, product, period). Values
 * stored verbatim from source — quantity_kg + value_native_eur for
 * Eurostat, value_usd computed via FX at ingest time so cross-source
 * comparison works without per-query conversion.
 *
 * Distinct from per-cargo data (Kpler/Vortexa) — that lives outside
 * this schema. This is country-level aggregate granularity, which is
 * what Eurostat publishes; per-cargo attribution requires AIS+customs
 * commercial sources.
 *
 * Public-domain / no companyId scoping. Like awards, customs flow data
 * is observed once and shared across tenants.
 */
export const customsImports = pgTable(
  'customs_imports',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /** 'eurostat-comext' | 'un-comtrade' | 'us-census' etc. */
    source: text('source').notNull(),

    /** ISO-2 country importing (or aggregate like 'EU27_2020'). */
    reporterCountry: text('reporter_country').notNull(),
    /** ISO-2 country of origin. For Libya: 'LY'. */
    partnerCountry: text('partner_country').notNull(),

    /** HS code (2/4/6/8 digits). Stored verbatim. */
    productCode: text('product_code').notNull(),
    /** Source-published label (e.g. 'Petroleum oils, crude'). */
    productLabel: text('product_label'),

    /** 'import' | 'export'. Eurostat encodes 1=import 2=export; we
        decode at ingest. */
    flowDirection: text('flow_direction').notNull(),

    /** First day of the period. Always month-aligned for monthly data. */
    period: date('period').notNull(),
    /** 'M' (monthly) | 'Y' (annual). */
    periodGranularity: text('period_granularity').notNull().default('M'),

    /** Net mass in kilograms. Eurostat publishes in 100kg units; we
        normalize to kg at ingest. Null when source omits quantity. */
    quantityKg: numeric('quantity_kg', { precision: 20, scale: 2 }),
    /** Source-native currency value. */
    valueNative: numeric('value_native', { precision: 20, scale: 2 }),
    valueCurrency: text('value_currency'), // 'EUR' for Eurostat
    /** Converted at ingest time using monthly FX rates. */
    valueUsd: numeric('value_usd', { precision: 20, scale: 2 }),

    /** Full source payload for re-parsing. */
    rawPayload: jsonb('raw_payload'),

    ingestedAt: timestamp('ingested_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => ({
    sourceUniq: uniqueIndex('customs_imports_source_uniq_idx').on(
      table.source,
      table.reporterCountry,
      table.partnerCountry,
      table.productCode,
      table.flowDirection,
      table.period,
    ),
    partnerProductIdx: index('customs_imports_partner_product_idx').on(
      table.partnerCountry,
      table.productCode,
      table.period,
    ),
    reporterProductIdx: index('customs_imports_reporter_product_idx').on(
      table.reporterCountry,
      table.productCode,
      table.period,
    ),
    periodIdx: index('customs_imports_period_idx').on(table.period),
  }),
);

export type CustomsImport = typeof customsImports.$inferSelect;
export type NewCustomsImport = typeof customsImports.$inferInsert;
