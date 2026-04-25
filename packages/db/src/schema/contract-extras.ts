import { pgTable, uuid, text, timestamp, numeric, date, integer, index } from 'drizzle-orm/pg-core';
import { contracts } from './contracts';

/**
 * Three flat tables hung off a contract for v1 of Contract Cloud:
 *
 *   contract_modifications  — mods / amendments / change orders
 *   contract_clins          — Contract Line Item Numbers (price structure)
 *   contract_task_areas     — SOW areas / domains / labor categories
 *
 * Kept as separate tables (not JSONB on contracts) so each row gets a
 * stable id for editing, can be filtered/sorted, and so we can later
 * add per-row audit / document attachments without schema churn.
 */

export type ModificationActionType =
  | 'admin'
  | 'funding'
  | 'scope'
  | 'period_of_performance'
  | 'price'
  | 'novation'
  | 'termination'
  | 'other';

export const MODIFICATION_ACTION_TYPES: ModificationActionType[] = [
  'admin',
  'funding',
  'scope',
  'period_of_performance',
  'price',
  'novation',
  'termination',
  'other',
];

export const contractModifications = pgTable(
  'contract_modifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    contractId: uuid('contract_id')
      .references(() => contracts.id, { onDelete: 'cascade' })
      .notNull(),

    modNumber: text('mod_number').notNull(),
    actionDate: date('action_date'),
    actionType: text('action_type').$type<ModificationActionType>().notNull().default('other'),
    description: text('description'),

    /** Net change in obligated funding for this mod (signed; can be negative). */
    fundingChange: numeric('funding_change', { precision: 20, scale: 2 }),
    currency: text('currency').default('USD'),

    documentUrl: text('document_url'),
    /** Free-text source attribution (e.g. "Document Upload", "FPDS-NG"). */
    source: text('source'),

    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => ({
    contractIdx: index('contract_modifications_contract_idx').on(table.contractId),
  }),
);

export type ContractModification = typeof contractModifications.$inferSelect;
export type NewContractModification = typeof contractModifications.$inferInsert;

export type ClinType = 'fixed_price' | 'cost_plus' | 'time_and_materials' | 'labor_hour' | 'other';

export const CLIN_TYPES: ClinType[] = [
  'fixed_price',
  'cost_plus',
  'time_and_materials',
  'labor_hour',
  'other',
];

export const contractClins = pgTable(
  'contract_clins',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    contractId: uuid('contract_id')
      .references(() => contracts.id, { onDelete: 'cascade' })
      .notNull(),

    clinNumber: text('clin_number').notNull(),
    title: text('title').notNull(),
    clinType: text('clin_type').$type<ClinType>().notNull().default('fixed_price'),

    quantity: numeric('quantity', { precision: 14, scale: 4 }),
    unitOfMeasure: text('unit_of_measure'),
    unitPrice: numeric('unit_price', { precision: 14, scale: 4 }),
    amount: numeric('amount', { precision: 20, scale: 2 }),

    periodStart: date('period_start'),
    periodEnd: date('period_end'),

    notes: text('notes'),

    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => ({
    contractIdx: index('contract_clins_contract_idx').on(table.contractId),
  }),
);

export type ContractClin = typeof contractClins.$inferSelect;
export type NewContractClin = typeof contractClins.$inferInsert;

export const contractTaskAreas = pgTable(
  'contract_task_areas',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    contractId: uuid('contract_id')
      .references(() => contracts.id, { onDelete: 'cascade' })
      .notNull(),

    name: text('name').notNull(),
    description: text('description'),
    /** Free-text scope summary (one paragraph). Long-form SOW excerpts go in notes. */
    scope: text('scope'),

    periodStart: date('period_start'),
    periodEnd: date('period_end'),

    notes: text('notes'),

    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => ({
    contractIdx: index('contract_task_areas_contract_idx').on(table.contractId),
  }),
);

export type ContractTaskArea = typeof contractTaskAreas.$inferSelect;
export type NewContractTaskArea = typeof contractTaskAreas.$inferInsert;
