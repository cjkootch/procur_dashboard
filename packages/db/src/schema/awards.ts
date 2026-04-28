import {
  pgTable,
  uuid,
  text,
  timestamp,
  numeric,
  date,
  jsonb,
  integer,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';
import { jurisdictions } from './jurisdictions';
import { agencies } from './agencies';
import { opportunities } from './opportunities';
import { awardAwardees } from './award-awardees';

/**
 * Public tender awards — backward-looking record of who has won what.
 * One row per (source_portal, source_award_id). For multi-supplier
 * consortium awards, see award_awardees.
 *
 * Distinct from `opportunities` (forward-looking solicitations) and
 * `external_suppliers` (registry of orgs registered to bid). Awards
 * close the loop between those two by recording the realized winner.
 *
 * Public-domain table — shared across all Procur tenants. No
 * companyId scoping; the data is observed from public portals and is
 * the same for everyone.
 *
 * UNSPSC, CPV, and NAICS classification codes are stored as text
 * arrays so a single award can carry multiple codes (common when an
 * award covers multiple line items).
 */
export const awards = pgTable(
  'awards',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    // ─── Source ──────────────────────────────────────────────────
    sourcePortal: text('source_portal').notNull(),       // 'gojep', 'dr_dgcp_ocds', 'sam_gov', 'ungm', etc.
    sourceAwardId: text('source_award_id').notNull(),    // portal's native award id
    sourceUrl: text('source_url'),
    sourceUrlArchived: text('source_url_archived'),       // wayback / R2 snapshot
    rawPayload: jsonb('raw_payload'),                     // full scraped record for re-parsing

    // ─── Linkage ─────────────────────────────────────────────────
    jurisdictionId: uuid('jurisdiction_id').references(() => jurisdictions.id),
    agencyId: uuid('agency_id').references(() => agencies.id),
    opportunityId: uuid('opportunity_id').references(() => opportunities.id),

    // ─── Buyer ───────────────────────────────────────────────────
    buyerName: text('buyer_name').notNull(),              // verbatim from source
    buyerCountry: text('buyer_country').notNull(),        // ISO 3166-1 alpha-2 (validated app-side)
    beneficiaryCountry: text('beneficiary_country'),      // mirrors opportunities.beneficiary_country

    // ─── Object ──────────────────────────────────────────────────
    title: text('title'),
    commodityDescription: text('commodity_description'),
    unspscCodes: text('unspsc_codes').array(),            // GIN-indexed
    cpvCodes: text('cpv_codes').array(),
    naicsCodes: text('naics_codes').array(),
    /**
     * Internal taxonomy mapping for fast filtering. Free-text array
     * matching values like 'petroleum-fuels', 'food-commodities',
     * 'vehicles', 'aviation-fuels', 'crude-oil', etc. Set by an
     * enrichment step (LLM classification or rules) at ingest time.
     */
    categoryTags: text('category_tags').array(),

    // ─── Money & timing ──────────────────────────────────────────
    contractValueNative: numeric('contract_value_native', { precision: 20, scale: 2 }),
    contractCurrency: text('contract_currency'),           // 'USD', 'DOP', 'JMD', etc.
    contractValueUsd: numeric('contract_value_usd', { precision: 20, scale: 2 }),  // converted at award_date FX
    contractDurationMonths: integer('contract_duration_months'),

    awardDate: date('award_date').notNull(),
    performanceStart: date('performance_start'),
    performanceEnd: date('performance_end'),

    // ─── Lifecycle ───────────────────────────────────────────────
    status: text('status').default('active').notNull(),    // active | terminated | expired | unknown
    scrapedAt: timestamp('scraped_at').defaultNow().notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => ({
    sourceUniq: uniqueIndex('awards_source_uniq_idx').on(
      table.sourcePortal,
      table.sourceAwardId,
    ),
    buyerCountryIdx: index('awards_buyer_country_idx').on(table.buyerCountry),
    beneficiaryCountryIdx: index('awards_beneficiary_country_idx')
      .on(table.beneficiaryCountry)
      .where(sql`${table.beneficiaryCountry} IS NOT NULL`),
    awardDateIdx: index('awards_award_date_idx').on(table.awardDate),
    valueUsdIdx: index('awards_value_usd_idx')
      .on(table.contractValueUsd)
      .where(sql`${table.contractValueUsd} IS NOT NULL`),
    unspscIdx: index('awards_unspsc_idx').using('gin', table.unspscCodes),
    cpvIdx: index('awards_cpv_idx').using('gin', table.cpvCodes),
    categoryTagsIdx: index('awards_category_tags_idx').using('gin', table.categoryTags),
    descriptionTrgmIdx: index('awards_description_trgm_idx').using(
      'gin',
      sql`${table.commodityDescription} gin_trgm_ops`,
    ),
  }),
);

export const awardsRelations = relations(awards, ({ one, many }) => ({
  jurisdiction: one(jurisdictions, {
    fields: [awards.jurisdictionId],
    references: [jurisdictions.id],
  }),
  agency: one(agencies, {
    fields: [awards.agencyId],
    references: [agencies.id],
  }),
  opportunity: one(opportunities, {
    fields: [awards.opportunityId],
    references: [opportunities.id],
  }),
  awardees: many(awardAwardees),
}));

export type Award = typeof awards.$inferSelect;
export type NewAward = typeof awards.$inferInsert;
