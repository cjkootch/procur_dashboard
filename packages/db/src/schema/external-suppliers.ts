import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
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
  }),
);

export type ExternalSupplier = typeof externalSuppliers.$inferSelect;
export type NewExternalSupplier = typeof externalSuppliers.$inferInsert;
