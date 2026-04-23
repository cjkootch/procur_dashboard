import { pgTable, uuid, text, timestamp, numeric, integer, jsonb } from 'drizzle-orm/pg-core';
import { pursuits } from './pursuits';

export const pricingModels = pgTable('pricing_models', {
  id: uuid('id').primaryKey().defaultRandom(),
  pursuitId: uuid('pursuit_id')
    .references(() => pursuits.id)
    .notNull()
    .unique(),

  pricingStrategy: text('pricing_strategy').notNull(),
  basePeriodMonths: integer('base_period_months'),
  optionYears: integer('option_years').default(0),
  escalationRate: numeric('escalation_rate', { precision: 5, scale: 2 }).default('0'),
  hoursPerFte: integer('hours_per_fte').default(2080),

  governmentEstimate: numeric('government_estimate', { precision: 20, scale: 2 }),
  ceilingValue: numeric('ceiling_value', { precision: 20, scale: 2 }),
  targetValue: numeric('target_value', { precision: 20, scale: 2 }),
  targetFeePct: numeric('target_fee_pct', { precision: 5, scale: 2 }),

  fringeRate: numeric('fringe_rate', { precision: 5, scale: 2 }),
  overheadRate: numeric('overhead_rate', { precision: 5, scale: 2 }),
  gaRate: numeric('ga_rate', { precision: 5, scale: 2 }),
  wrapRate: numeric('wrap_rate', { precision: 5, scale: 2 }),

  currency: text('currency').default('USD'),
  fxRateToUsd: numeric('fx_rate_to_usd', { precision: 10, scale: 4 }),

  notes: text('notes'),

  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const laborCategories = pgTable('labor_categories', {
  id: uuid('id').primaryKey().defaultRandom(),
  pricingModelId: uuid('pricing_model_id')
    .references(() => pricingModels.id)
    .notNull(),

  title: text('title').notNull(),
  type: text('type'),
  directRate: numeric('direct_rate', { precision: 10, scale: 2 }),
  loadedRate: numeric('loaded_rate', { precision: 10, scale: 2 }),
  hoursPerYear: integer('hours_per_year'),

  yearlyBreakdown: jsonb('yearly_breakdown').$type<
    Array<{
      year: number;
      rate: number;
      hours: number;
      cost: number;
    }>
  >(),

  totalCost: numeric('total_cost', { precision: 20, scale: 2 }),

  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export type PricingModel = typeof pricingModels.$inferSelect;
export type NewPricingModel = typeof pricingModels.$inferInsert;
export type LaborCategory = typeof laborCategories.$inferSelect;
export type NewLaborCategory = typeof laborCategories.$inferInsert;
