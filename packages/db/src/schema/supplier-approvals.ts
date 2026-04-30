import { pgTable, uuid, text, timestamp, uniqueIndex, index } from 'drizzle-orm/pg-core';
import { companies } from './companies';
import { users } from './users';

/**
 * Per-tenant supplier-approval / KYC state. See migration 0054 for
 * the full status taxonomy + design notes.
 */
export const SUPPLIER_APPROVAL_STATUSES = [
  'pending',
  'kyc_in_progress',
  'approved_without_kyc',
  'approved_with_kyc',
  'rejected',
  'expired',
] as const;
export type SupplierApprovalStatus = (typeof SUPPLIER_APPROVAL_STATUSES)[number];

export function isSupplierApprovalStatus(s: string | null | undefined): s is SupplierApprovalStatus {
  return s != null && (SUPPLIER_APPROVAL_STATUSES as readonly string[]).includes(s);
}

/** True when the status counts as "we can transact" (with or without formal KYC). */
export function isApprovedStatus(s: SupplierApprovalStatus | null | undefined): boolean {
  return s === 'approved_with_kyc' || s === 'approved_without_kyc';
}

export const supplierApprovals = pgTable(
  'supplier_approvals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    /** known_entities.slug OR external_suppliers.id — see column comment in 0054. */
    entitySlug: text('entity_slug').notNull(),
    /** Cached for display when the entity row hasn't been fetched. */
    entityName: text('entity_name'),
    status: text('status').notNull().$type<SupplierApprovalStatus>(),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    createdBy: uuid('created_by').references(() => users.id),
  },
  (t) => ({
    companyEntityUnique: uniqueIndex('supplier_approvals_company_entity_unique').on(
      t.companyId,
      t.entitySlug,
    ),
    companyStatusIdx: index('idx_supplier_approvals_company_status').on(t.companyId, t.status),
  }),
);

export type SupplierApproval = typeof supplierApprovals.$inferSelect;
export type NewSupplierApproval = typeof supplierApprovals.$inferInsert;
