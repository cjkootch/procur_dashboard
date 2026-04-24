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

/**
 * Where the labor rate came from — tracked per-category for audit
 * traceability. Stored as a text column (not a PG enum) so new sources
 * can be added by the application layer without a migration. The
 * canonical list for v1:
 *
 *   manual                       — user entered, no reference document
 *   published_rate_card          — e.g. GSA Schedule, published govt rate card
 *   collective_agreement         — CBA / union agreement
 *   prior_contract               — rate from a prior similar contract
 *   multilateral_rate_schedule   — CDB / IDB / World Bank / AfDB rate tables
 *   other                        — anything else; use with a reference
 */
export const LABOR_RATE_SOURCES = [
  'manual',
  'published_rate_card',
  'collective_agreement',
  'prior_contract',
  'multilateral_rate_schedule',
  'other',
] as const;
export type LaborRateSource = (typeof LABOR_RATE_SOURCES)[number];

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

  // Provenance for the rate. Nullable — existing rows predating this
  // column default to `manual` in application code.
  rateSource: text('rate_source').$type<LaborRateSource>(),
  rateSourceReference: text('rate_source_reference'),

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
