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

  /** References deal_structure_templates(slug). Set when the contract
   *  was instantiated from a catalog template. NULL for legacy
   *  contracts (forward-only per
   *  docs/deal-structures-catalog-brief.md §10.4). Surfaces "which
   *  templates close at what rate" analytics once 6+ months of
   *  contracts reference templates. */
  dealStructureTemplateSlug: text('deal_structure_template_slug'),

  /** Slugs of commission_structures that actually applied to this
   *  contract — captured at signature time, may differ from
   *  proposals.applicableCommissionSlugs if negotiation altered the
   *  fee structure. Empty array when no structures applied. */
  appliedCommissionSlugs: text('applied_commission_slugs')
    .array()
    .notNull()
    .default([]),

  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => ({
    companyIdx: index('contracts_company_idx').on(table.companyId),
    pursuitIdx: index('contracts_pursuit_idx').on(table.pursuitId),
    parentIdx: index('contracts_parent_idx').on(table.parentContractId),
    templateSlugIdx: index('contracts_template_slug_idx').on(
      table.dealStructureTemplateSlug,
    ),
  }),
);

export type Contract = typeof contracts.$inferSelect;
export type NewContract = typeof contracts.$inferInsert;
