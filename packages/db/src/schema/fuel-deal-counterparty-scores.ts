import {
  doublePrecision,
  index,
  pgTable,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';
import { counterpartyRiskTierEnum } from './enums';
import { organizations } from './organizations';

/**
 * Per docs/vex-into-procur-merge-brief.md Phase 5. Structured
 * counterparty risk assessment. Each dimension is 0-100 (higher =
 * riskier). `composite_score` is a weighted average; tier +
 * recommended terms are human judgment columns. `scored_by` is text
 * (no FK) because procur users.id is uuid.
 */
export const fuelDealCounterpartyScores = pgTable(
  'fuel_deal_counterparty_scores',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    scoredAt: timestamp('scored_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    scoredBy: text('scored_by'),

    countryRisk: doublePrecision('country_risk').notNull(),
    paymentHistoryRisk: doublePrecision('payment_history_risk').notNull(),
    creditRisk: doublePrecision('credit_risk').notNull(),
    sanctionsExposureRisk: doublePrecision('sanctions_exposure_risk').notNull(),
    ownershipTransparencyRisk: doublePrecision(
      'ownership_transparency_risk',
    ).notNull(),
    regulatoryComplexityRisk: doublePrecision(
      'regulatory_complexity_risk',
    ).notNull(),
    operationalRisk: doublePrecision('operational_risk').notNull(),
    concentrationRisk: doublePrecision('concentration_risk').notNull(),

    compositeScore: doublePrecision('composite_score').notNull(),
    riskTier: counterpartyRiskTierEnum('risk_tier').notNull(),
    recommendedPaymentTerms: text('recommended_payment_terms'),
    recommendedMaxExposureUsd: doublePrecision('recommended_max_exposure_usd'),
    notes: text('notes'),
  },
  (t) => ({
    orgIdx: index('fuel_deal_counterparty_scores_org_idx').on(t.orgId),
    tierIdx: index('fuel_deal_counterparty_scores_tier_idx').on(t.riskTier),
  }),
);

export type FuelDealCounterpartyScore =
  typeof fuelDealCounterpartyScores.$inferSelect;
export type NewFuelDealCounterpartyScore =
  typeof fuelDealCounterpartyScores.$inferInsert;
