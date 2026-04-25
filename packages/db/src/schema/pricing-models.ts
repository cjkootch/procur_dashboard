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

  /**
   * How indirect rates compound onto direct labor:
   *   multiplicative — (1 + fringe) × (1 + overhead) × (1 + ga). Default
   *                    for US federal-style cost models. Layers stack:
   *                    overhead applies on top of (DL + fringe), G&A on
   *                    top of (DL + fringe + overhead).
   *   additive       — fringe% + overhead% + ga% all applied to direct
   *                    labor independently. Common in some IFI / MDB
   *                    cost rules and quick-look approximations.
   *
   * The indirect-rate UI on the pricer lets users flip between modes;
   * persisting the choice here keeps the pricer math + the UI's
   * 'currently saved' state aligned across reloads.
   */
  indirectRateMode: text('indirect_rate_mode')
    .$type<'multiplicative' | 'additive'>()
    .default('multiplicative')
    .notNull(),

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

  // Role description + required certifications. Shown in the expandable
  // row on the Labor Categories tab and available to feed into AI
  // proposal drafting (personnel section) so the narrative matches the
  // priced role.
  description: text('description'),
  requirementsCertifications: text('requirements_certifications'),

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

/**
 * Non-labor line items: ODCs, travel, materials, subcontracts, misc.
 * Labor lives in the laborCategories table because it needs per-year
 * escalation math + wrap-rate loading; putting both in one table would
 * muddle the math.
 *
 * The Line Items tab combines both views: the auto-calculated labor
 * CLINs (computed from labor_categories × wrap rate × escalation) on
 * top, then this table's rows below for everything else.
 */
export const LINE_ITEM_CATEGORIES = [
  'odc',
  'travel',
  'materials',
  'subcontract',
  'other',
] as const;
export type LineItemCategory = (typeof LINE_ITEM_CATEGORIES)[number];

export const pricingLineItems = pgTable('pricing_line_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  pricingModelId: uuid('pricing_model_id')
    .references(() => pricingModels.id, { onDelete: 'cascade' })
    .notNull(),

  clinNumber: text('clin_number'),
  title: text('title').notNull(),
  category: text('category').$type<LineItemCategory>().notNull().default('other'),

  // Line amount. quantity × unitPrice when both set, otherwise the
  // manually entered amount wins. Math lives in the app layer — the
  // column stays authoritative so sort/aggregate queries work.
  quantity: numeric('quantity', { precision: 14, scale: 4 }),
  unitOfMeasure: text('unit_of_measure'),
  unitPrice: numeric('unit_price', { precision: 14, scale: 4 }),
  amount: numeric('amount', { precision: 20, scale: 2 }),

  startDate: text('start_date'), // ISO YYYY-MM-DD; kept as text for date-only handling
  endDate: text('end_date'),
  notes: text('notes'),

  sortOrder: integer('sort_order').notNull().default(0),

  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export type PricingLineItem = typeof pricingLineItems.$inferSelect;
export type NewPricingLineItem = typeof pricingLineItems.$inferInsert;
