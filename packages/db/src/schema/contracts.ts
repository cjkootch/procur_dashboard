import {
  pgTable,
  uuid,
  text,
  timestamp,
  numeric,
  date,
  jsonb,
  index,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { contractStatusEnum, contractTierEnum } from './enums';
import { companies } from './companies';
import { pursuits } from './pursuits';

export const contracts = pgTable(
  'contracts',
  {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id')
    .references(() => companies.id)
    .notNull(),
  pursuitId: uuid('pursuit_id').references(() => pursuits.id),

  awardTitle: text('award_title').notNull(),
  tier: contractTierEnum('tier').default('prime').notNull(),
  parentContractId: uuid('parent_contract_id').references((): AnyPgColumn => contracts.id),

  contractNumber: text('contract_number'),
  parentContractNumber: text('parent_contract_number'),
  taskOrderNumber: text('task_order_number'),
  subcontractNumber: text('subcontract_number'),

  awardingAgency: text('awarding_agency'),
  primeContractor: text('prime_contractor'),

  awardDate: date('award_date'),
  startDate: date('start_date'),
  endDate: date('end_date'),

  totalValue: numeric('total_value', { precision: 20, scale: 2 }),
  currency: text('currency').default('USD'),
  totalValueUsd: numeric('total_value_usd', { precision: 20, scale: 2 }),

  contractDocumentUrl: text('contract_document_url'),
  pwsSowDocumentUrl: text('pws_sow_document_url'),

  status: contractStatusEnum('status').default('active').notNull(),

  obligations: jsonb('obligations').$type<
    Array<{
      id: string;
      description: string;
      dueDate?: string;
      frequency?: 'once' | 'monthly' | 'quarterly' | 'annually';
      status: 'pending' | 'in_progress' | 'completed' | 'overdue';
    }>
  >(),

  notes: text('notes'),

  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => ({
    companyIdx: index('contracts_company_idx').on(table.companyId),
    pursuitIdx: index('contracts_pursuit_idx').on(table.pursuitId),
    parentIdx: index('contracts_parent_idx').on(table.parentContractId),
  }),
);

export type Contract = typeof contracts.$inferSelect;
export type NewContract = typeof contracts.$inferInsert;
