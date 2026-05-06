import {
  boolean,
  doublePrecision,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';
import { scenarioTypeEnum } from './enums';
import { fuelDeals } from './fuel-deals';

/**
 * Per docs/vex-into-procur-merge-brief.md Phase 5. Scenario versions
 * of a deal. The `is_active` row is canonical; overrides resolve
 * against the base deal (null override = use base value). The
 * calculator's results land in `results_json` — opaque at the schema
 * layer.
 */
export const fuelDealScenarios = pgTable(
  'fuel_deal_scenarios',
  {
    id: text('id').primaryKey(),
    dealId: text('deal_id')
      .notNull()
      .references(() => fuelDeals.id, { onDelete: 'cascade' }),
    scenarioName: text('scenario_name').notNull(),
    scenarioType: scenarioTypeEnum('scenario_type').notNull().default('base'),
    isActive: boolean('is_active').notNull().default(false),

    volumeUsgOverride: doublePrecision('volume_usg_override'),
    sellPricePerUsg: doublePrecision('sell_price_per_usg').notNull(),
    productCostOverride: doublePrecision('product_cost_override'),
    freightOverridePerUsg: doublePrecision('freight_override_per_usg'),
    fxRateOverride: doublePrecision('fx_rate_override'),
    demurrageDaysOverride: doublePrecision('demurrage_days_override'),
    storageDaysOverride: doublePrecision('storage_days_override'),

    resultsJson: jsonb('results_json').$type<Record<string, unknown> | null>(),
    score: doublePrecision('score'),
    recommendation: text('recommendation'),
    calculatedAt: timestamp('calculated_at', { withTimezone: true }),

    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    dealIdx: index('fuel_deal_scenarios_deal_idx').on(t.dealId),
    activeIdx: index('fuel_deal_scenarios_active_idx').on(
      t.dealId,
      t.isActive,
    ),
  }),
);

export type FuelDealScenario = typeof fuelDealScenarios.$inferSelect;
export type NewFuelDealScenario = typeof fuelDealScenarios.$inferInsert;
