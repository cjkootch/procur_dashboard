import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  bigint,
  integer,
  date,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';
import { jurisdictions } from './jurisdictions';

/**
 * Public supplier-registry rows scraped from government procurement
 * portals. NOT the same as `companies` (those are Procur tenants /
 * paying customers). This table holds the directory of organisations
 * registered to bid on public tenders in a given jurisdiction.
 *
 * Multi-tenant model: shared market data, no companyId. Like
 * `jurisdictions`, `agencies`, `opportunities` — every Procur tenant
 * sees the same supplier directory for the jurisdictions they care
 * about. Per-tenant overlays (notes, contact attempts, etc.) belong
 * in a separate `supplier_engagements` table later.
 *
 * Source identity: `(jurisdictionId, sourceName, sourceReferenceId)`
 * is unique. `sourceCategory` distinguishes registry buckets where
 * the source portal segments suppliers (e.g. GOJEP's gs / w14 / w5).
 */
export const externalSuppliers = pgTable(
  'external_suppliers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    jurisdictionId: uuid('jurisdiction_id')
      .references(() => jurisdictions.id)
      .notNull(),

    sourceName: text('source_name').notNull(),
    sourceReferenceId: text('source_reference_id').notNull(),
    sourceCategory: text('source_category'),
    sourceUrl: text('source_url'),

    organisationName: text('organisation_name').notNull(),
    address: text('address'),
    phone: text('phone'),
    email: text('email'),
    country: text('country'),
    contactPerson: text('contact_person'),
    registeredAt: timestamp('registered_at'),

    rawData: jsonb('raw_data'),
    firstSeenAt: timestamp('first_seen_at').defaultNow().notNull(),
    lastSeenAt: timestamp('last_seen_at').defaultNow().notNull(),

    /** Identity key for external corporate-data APIs. Mirrors
        known_entities.primary_domain — see that table for why.
        NULL by default; populated by analyst entry, domain-extraction
        passes over scraped data, or Apollo match-by-name. */
    primaryDomain: text('primary_domain'),

    // ─── Apollo.io enrichment cache (per apollo-integration-brief.md) ─

    apolloOrgId: text('apollo_org_id'),
    apolloSyncedAt: timestamp('apollo_synced_at'),
    apolloFundingStage: text('apollo_funding_stage'),
    apolloTotalFunding: bigint('apollo_total_funding', { mode: 'number' }),
    apolloLatestFundingAt: date('apollo_latest_funding_at'),
    apolloEstimatedEmployees: integer('apollo_estimated_employees'),
    apolloAnnualRevenue: bigint('apollo_annual_revenue', { mode: 'number' }),
    apolloSnapshot: jsonb('apollo_snapshot'),

    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => ({
    sourceUniq: uniqueIndex('ext_supplier_source_uniq_idx').on(
      table.jurisdictionId,
      table.sourceName,
      table.sourceReferenceId,
    ),
    jurisdictionIdx: index('ext_supplier_jurisdiction_idx').on(table.jurisdictionId),
    nameIdx: index('ext_supplier_name_idx').on(table.organisationName),
    primaryDomainIdx: index('external_suppliers_primary_domain_idx').on(table.primaryDomain),
    apolloOrgIdIdx: index('external_suppliers_apollo_org_id_idx').on(table.apolloOrgId),
    apolloFundingStageIdx: index('external_suppliers_apollo_funding_stage_idx').on(
      table.apolloFundingStage,
    ),
    apolloLatestFundingAtIdx: index('external_suppliers_apollo_latest_funding_at_idx').on(
      table.apolloLatestFundingAt,
    ),
  }),
);

export type ExternalSupplier = typeof externalSuppliers.$inferSelect;
export type NewExternalSupplier = typeof externalSuppliers.$inferInsert;
