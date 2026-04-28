import { pgTable, uuid, text, jsonb, timestamp, index } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { externalSuppliers } from './external-suppliers';

/**
 * Per-supplier behavioral signals captured during VTC's interactions
 * with the supplier graph. Distinct from awards (publicly observable
 * facts) — these are private learnings that compound into the moat.
 *
 * Signal types (free-text, application-defined):
 *   rfq_response_time_hrs
 *   rfq_decline_reason
 *   price_vs_index_pct
 *   delivery_on_time
 *   no_response
 *   capability_confirmed
 *   capability_denied
 *   credit_check_passed
 *   ofac_screen_passed
 *
 * Free-text by design — application code defines the canonical set
 * and roll-up logic. New signal types should not require a migration.
 *
 * Roll-ups (avg_response_time_hrs, last_responsive_at, etc.) live
 * in supplier_capability_summary (materialized view) and are
 * refreshed nightly.
 *
 * ─── TENANT SCOPING TODO ─────────────────────────────────────────
 * Public-domain for v1 (no companyId column) because the table is
 * empty. As soon as a tenant logs the first private signal, this
 * table starts holding tenant-confidential data and MUST be:
 *   1. Migrated to add a companyId column (NOT NULL, FK to companies)
 *      with backfill of any pre-existing rows to a designated owner.
 *   2. Filtered by ctx.companyId in every query that reads from it
 *      (analyzeSupplier, supplier-roll-up jobs, etc).
 *   3. Excluded from the supplier_capability_summary materialized
 *      view, OR the view becomes per-tenant.
 * Anyone wiring the first write to this table: stop and address the
 * above before merging that PR. See queries that reference this
 * table for matching warning comments.
 */
export const supplierSignals = pgTable(
  'supplier_signals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    supplierId: uuid('supplier_id')
      .references(() => externalSuppliers.id, { onDelete: 'cascade' })
      .notNull(),

    signalType: text('signal_type').notNull(),
    signalValue: jsonb('signal_value').notNull(),

    /** Optional reference to the RFQ that produced this signal.
        Free-text uuid string for now — wire to a future rfqs table. */
    rfqId: text('rfq_id'),

    observedAt: timestamp('observed_at').defaultNow().notNull(),
  },
  (table) => ({
    supplierObservedIdx: index('supplier_signals_supplier_observed_idx').on(
      table.supplierId,
      table.observedAt,
    ),
    typeIdx: index('supplier_signals_type_idx').on(table.signalType),
  }),
);

export const supplierSignalsRelations = relations(supplierSignals, ({ one }) => ({
  supplier: one(externalSuppliers, {
    fields: [supplierSignals.supplierId],
    references: [externalSuppliers.id],
  }),
}));

export type SupplierSignal = typeof supplierSignals.$inferSelect;
export type NewSupplierSignal = typeof supplierSignals.$inferInsert;
