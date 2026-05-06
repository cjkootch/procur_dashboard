import { index, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { dealDocumentTypeEnum } from './enums';
import { fuelDeals } from './fuel-deals';

/**
 * Per docs/vex-into-procur-merge-brief.md Phase 5. Supporting documents
 * linked to a deal. `storage_key` points at S3 (or whatever blob store
 * is configured); the row carries metadata only. `uploaded_by` is text
 * (no FK) because procur users.id is uuid. Coexists with procur's
 * existing polymorphic `documents` (opportunity-scoped) — fuel-deal
 * docs are deal-scoped and use this dedicated table for clarity.
 */
export const fuelDealDocuments = pgTable(
  'fuel_deal_documents',
  {
    id: text('id').primaryKey(),
    dealId: text('deal_id')
      .notNull()
      .references(() => fuelDeals.id, { onDelete: 'cascade' }),
    documentType: dealDocumentTypeEnum('document_type').notNull(),
    storageKey: text('storage_key').notNull(),
    filename: text('filename').notNull(),
    uploadedBy: text('uploaded_by'),
    uploadedAt: timestamp('uploaded_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    notes: text('notes'),
  },
  (t) => ({
    dealIdx: index('fuel_deal_documents_deal_idx').on(t.dealId),
    typeIdx: index('fuel_deal_documents_type_idx').on(t.dealId, t.documentType),
  }),
);

export type FuelDealDocument = typeof fuelDealDocuments.$inferSelect;
export type NewFuelDealDocument = typeof fuelDealDocuments.$inferInsert;
