import {
  pgTable,
  uuid,
  text,
  numeric,
  boolean,
  timestamp,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';
import { externalSuppliers } from './external-suppliers';

/**
 * Per-portal name variants that all map to a single canonical
 * supplier. Necessary because the same supplier appears across 10+
 * portals with 10+ spelling variants ("Vitol SA" / "VITOL S.A." /
 * "Vitol Group" / etc). Without this table, dedup happens at insert
 * time with no audit trail and no way to undo bad merges.
 *
 * Public-domain table — no companyId scoping.
 *
 * `alias_normalized` is lowercased + suffix-stripped + whitespace-
 * collapsed. The trigram index supports fuzzy match queries during
 * the merge process.
 */
export const supplierAliases = pgTable(
  'supplier_aliases',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    supplierId: uuid('supplier_id')
      .references(() => externalSuppliers.id, { onDelete: 'cascade' })
      .notNull(),

    alias: text('alias').notNull(),
    aliasNormalized: text('alias_normalized').notNull(),

    sourcePortal: text('source_portal'),
    /** 0.00..1.00 — match score when this alias was linked to the canonical
        supplier. Set to 1.0 for human-verified merges. */
    confidence: numeric('confidence', { precision: 3, scale: 2 }),
    verified: boolean('verified').default(false).notNull(),

    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => ({
    aliasNormalizedIdx: index('supplier_aliases_normalized_trgm_idx').using(
      'gin',
      sql`${table.aliasNormalized} gin_trgm_ops`,
    ),
    supplierIdx: index('supplier_aliases_supplier_idx').on(table.supplierId),
    uniqueAlias: uniqueIndex('supplier_aliases_uniq_idx').on(
      table.supplierId,
      table.aliasNormalized,
    ),
  }),
);

export const supplierAliasesRelations = relations(supplierAliases, ({ one }) => ({
  supplier: one(externalSuppliers, {
    fields: [supplierAliases.supplierId],
    references: [externalSuppliers.id],
  }),
}));

export type SupplierAlias = typeof supplierAliases.$inferSelect;
export type NewSupplierAlias = typeof supplierAliases.$inferInsert;
