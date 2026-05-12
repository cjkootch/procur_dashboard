import {
  bigint,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

/**
 * USDA FSIS Meat, Poultry and Egg Product Inspection Directory.
 *
 * Every federally-inspected establishment in the US — the regulatory
 * universe of suppliers legally allowed to slaughter or process meat /
 * poultry / egg products for interstate commerce or export.
 *
 * Complements FAS ESR (country-level export data) by naming the
 * SOURCE facilities: "US shipped X MT pork to DR" + this table =
 * "from these 600+ USDA-approved hog establishments."
 *
 * Source: https://www.fsis.usda.gov/inspection/establishments/meat-poultry-and-egg-product-inspection-directory
 * Cadence: quarterly CSV publication.
 * Confidence: regulatory-grade — this list IS the universe of legal
 * US exporters for the covered species.
 */
export const usdaFsisEstablishments = pgTable(
  'usda_fsis_establishments',
  {
    /** FSIS-issued establishment number — "M-12345", "P-2580",
     *  "EST 38N", etc. Stable and serves as the primary key. */
    establishmentNumber: text('establishment_number').primaryKey(),
    legalName: text('legal_name').notNull(),
    dbaName: text('dba_name'),
    street: text('street'),
    city: text('city'),
    state: text('state'),
    zip: text('zip'),
    county: text('county'),
    phone: text('phone'),
    /** Multi-valued: 'slaughter' | 'processing' | 'plant' | 'import' | 'identification' */
    activities: text('activities').array().notNull().default([]),
    /** Multi-valued: 'swine' | 'cattle' | 'sheep' | 'goat' | 'equine' | 'poultry' | 'egg' */
    species: text('species').array().notNull().default([]),
    /** 'federal' | 'state' | 'talmadge-aiken' */
    grants: text('grants').array().notNull().default([]),
    latitude: numeric('latitude', { precision: 10, scale: 7 }),
    longitude: numeric('longitude', { precision: 10, scale: 7 }),
    rawPayload: jsonb('raw_payload'),
    // ── Enrichment columns (filled after MPI ingest) ──────────────────
    /** Apollo org linkage when enrichOrgsBatch matches the legal name
     *  to a domain. Null for facilities Apollo doesn't index (common
     *  for smaller regional processors). */
    apolloOrgId: text('apollo_org_id'),
    apolloSyncedAt: timestamp('apollo_synced_at'),
    estimatedEmployees: integer('estimated_employees'),
    annualRevenueUsd: bigint('annual_revenue_usd', { mode: 'number' }),
    websiteUrl: text('website_url'),
    primaryDomain: text('primary_domain'),
    industry: text('industry'),
    shortDescription: text('short_description'),
    /** Slaughter / processing capacity in head per day. Filled by a
     *  follow-up USDA AMS Livestock Slaughter ingest (see PR
     *  description). Null until that ships. */
    capacityHeadPerDay: integer('capacity_head_per_day'),
    capacitySource: text('capacity_source'),
    /** Product / cut detail surfaced from website-intelligence crawls
     *  (entity_web_summaries). Filled by a follow-up pipeline that
     *  joins MPI rows to crawled web summaries on primary_domain. */
    productSummary: text('product_summary'),
    productSummarySource: text('product_summary_source'),
    /** Slug of the corresponding `known_entities` row, created via the
     *  website-intelligence pipeline. NULL until promoted. The shadow
     *  rolodex entry is what downstream surfaces (lookup_known_entities,
     *  analyze_supplier, map view, web crawl) consume; this MPI row
     *  stays canonical for regulatory data. */
    linkedKnownEntitySlug: text('linked_known_entity_slug'),
    ingestedAt: timestamp('ingested_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => ({
    speciesIdx: index('usda_fsis_establishments_species_gin_idx').using(
      'gin',
      table.species,
    ),
    activitiesIdx: index('usda_fsis_establishments_activities_gin_idx').using(
      'gin',
      table.activities,
    ),
    stateIdx: index('usda_fsis_establishments_state_idx').on(table.state),
  }),
);

export type UsdaFsisEstablishment = typeof usdaFsisEstablishments.$inferSelect;
export type NewUsdaFsisEstablishment =
  typeof usdaFsisEstablishments.$inferInsert;
