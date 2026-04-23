import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  numeric,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';
import { pursuitStageEnum } from './enums';
import { companies } from './companies';
import { opportunities } from './opportunities';
import { users } from './users';

export const pursuits = pgTable(
  'pursuits',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .references(() => companies.id)
      .notNull(),
    opportunityId: uuid('opportunity_id')
      .references(() => opportunities.id)
      .notNull(),

    stage: pursuitStageEnum('stage').default('identification').notNull(),
    bidDecision: text('bid_decision'),
    bidDecisionReasoning: text('bid_decision_reasoning'),
    bidDecisionAt: timestamp('bid_decision_at'),

    pWin: numeric('p_win', { precision: 3, scale: 2 }),
    weightedValue: numeric('weighted_value', { precision: 20, scale: 2 }),

    captureAnswers: jsonb('capture_answers').$type<{
      winThemes?: string[];
      customerBudget?: number;
      customerPainPoints?: string[];
      incumbents?: Array<{ name: string; notes: string }>;
      competitors?: Array<{ name: string; strengths: string; weaknesses: string }>;
      differentiators?: string[];
      risksAndMitigations?: Array<{ risk: string; mitigation: string }>;
      teamPartners?: string[];
      customerRelationships?: Array<{ name: string; role: string; notes: string }>;
    }>(),

    assignedUserId: uuid('assigned_user_id').references(() => users.id),
    captureManagerId: uuid('capture_manager_id').references(() => users.id),

    submittedAt: timestamp('submitted_at'),
    submittedValue: numeric('submitted_value', { precision: 20, scale: 2 }),

    outcomeNotifiedAt: timestamp('outcome_notified_at'),
    wonAt: timestamp('won_at'),
    lostAt: timestamp('lost_at'),
    outcomeReasoning: text('outcome_reasoning'),

    notes: text('notes'),

    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => ({
    companyOppIdx: uniqueIndex('pursuit_company_opp_idx').on(table.companyId, table.opportunityId),
    stageIdx: index('pursuit_stage_idx').on(table.stage),
    companyStageIdx: index('pursuit_company_stage_idx').on(table.companyId, table.stage),
  }),
);

export type Pursuit = typeof pursuits.$inferSelect;
export type NewPursuit = typeof pursuits.$inferInsert;
