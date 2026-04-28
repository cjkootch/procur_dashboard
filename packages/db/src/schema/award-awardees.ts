import { pgTable, uuid, text, numeric, timestamp, primaryKey, index } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { awards } from './awards';
import { externalSuppliers } from './external-suppliers';

/**
 * Many-to-many link between awards and the suppliers who won them.
 * Most awards have one supplier, but consortia and joint ventures
 * are common in larger procurement (~5-10% of awards). Storing this
 * flat avoids losing consortium structure to a single-FK design.
 *
 * Public-domain table — no companyId scoping.
 *
 * Composite primary key on (award_id, supplier_id). Role and share
 * are per-link (not per-supplier).
 */
export const awardAwardees = pgTable(
  'award_awardees',
  {
    awardId: uuid('award_id')
      .references(() => awards.id, { onDelete: 'cascade' })
      .notNull(),
    supplierId: uuid('supplier_id')
      .references(() => externalSuppliers.id, { onDelete: 'cascade' })
      .notNull(),

    /** 'prime' | 'subcontractor' | 'consortium_member' | 'consortium_lead' */
    role: text('role').default('prime').notNull(),

    /** % of total contract value (0..100). Optional — many awards
        don't disclose the consortium share. */
    sharePct: numeric('share_pct', { precision: 5, scale: 2 }),

    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.awardId, table.supplierId] }),
    supplierIdx: index('award_awardees_supplier_idx').on(table.supplierId),
  }),
);

export const awardAwardeesRelations = relations(awardAwardees, ({ one }) => ({
  award: one(awards, {
    fields: [awardAwardees.awardId],
    references: [awards.id],
  }),
  supplier: one(externalSuppliers, {
    fields: [awardAwardees.supplierId],
    references: [externalSuppliers.id],
  }),
}));

export type AwardAwardee = typeof awardAwardees.$inferSelect;
export type NewAwardAwardee = typeof awardAwardees.$inferInsert;
