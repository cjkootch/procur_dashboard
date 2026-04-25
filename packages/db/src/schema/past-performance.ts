import {
  pgTable,
  uuid,
  text,
  timestamp,
  numeric,
  date,
  vector,
  index,
} from 'drizzle-orm/pg-core';
import { companies } from './companies';

export const pastPerformance = pgTable(
  'past_performance',
  {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id')
    .references(() => companies.id)
    .notNull(),

  projectName: text('project_name').notNull(),
  customerName: text('customer_name').notNull(),
  customerType: text('customer_type'),

  periodStart: date('period_start'),
  periodEnd: date('period_end'),
  totalValue: numeric('total_value', { precision: 20, scale: 2 }),
  currency: text('currency').default('USD'),

  scopeDescription: text('scope_description').notNull(),
  keyAccomplishments: text('key_accomplishments').array(),
  challenges: text('challenges'),
  outcomes: text('outcomes'),

  referenceName: text('reference_name'),
  referenceTitle: text('reference_title'),
  referenceEmail: text('reference_email'),
  referencePhone: text('reference_phone'),

  naicsCodes: text('naics_codes').array(),
  categories: text('categories').array(),
  keywords: text('keywords').array(),

  embedding: vector('embedding', { dimensions: 1536 }),

  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => ({
    companyIdx: index('past_performance_company_idx').on(table.companyId),
  }),
);

export type PastPerformance = typeof pastPerformance.$inferSelect;
export type NewPastPerformance = typeof pastPerformance.$inferInsert;
