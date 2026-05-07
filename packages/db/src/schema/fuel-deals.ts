import {
  boolean,
  date,
  doublePrecision,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import {
  dealCurrencyEnum,
  dealStatusEnum,
  dealTypeEnum,
  incotermEnum,
  ofacScreeningStatusEnum,
  paymentTermsEnum,
  pricingBasisEnum,
  productTypeEnum,
} from './enums';
import { organizations } from './organizations';
import { contacts } from './contacts';
import { leads } from './leads';
import { campaigns } from './campaigns';

/**
 * Per docs/vex-into-procur-merge-brief.md Phase 5. Fuel-deal record —
 * one row per negotiated transaction. Cost stack, cashflow events,
 * scenarios, and documents hang off `id`. Vessel + port references
 * are plain text without FK because procur's vessels (mmsi PK, AIS-
 * tracked) and ports (slug PK) have different PK shapes than vex's
 * — Phase 5 will figure out wiring.
 */
export const fuelDeals = pgTable(
  'fuel_deals',
  {
    id: text('id').primaryKey(),
    dealRef: text('deal_ref').notNull(),
    status: dealStatusEnum('status').notNull().default('draft'),
    dealType: dealTypeEnum('deal_type').notNull().default('spot'),
    /** Cadence: one_off | weekly | biweekly | monthly | custom.
     *  When `custom`, dealFrequencyIntervalDays carries the cadence. */
    dealFrequency: text('deal_frequency').notNull().default('one_off'),
    dealFrequencyIntervalDays: integer('deal_frequency_interval_days'),
    dealFrequencyNotes: text('deal_frequency_notes'),
    product: productTypeEnum('product').notNull(),
    productGrade: text('product_grade'),
    productSpecNotes: text('product_spec_notes'),

    originCountry: text('origin_country'),
    originPort: text('origin_port'),
    originTerminal: text('origin_terminal'),
    destinationCountry: text('destination_country'),
    destinationPort: text('destination_port'),
    destinationTerminal: text('destination_terminal'),

    incoterm: incotermEnum('incoterm').notNull(),
    pricingBasis: pricingBasisEnum('pricing_basis').notNull(),
    pricingFormula: text('pricing_formula'),
    priceLockDate: date('price_lock_date'),
    priceLockTime: text('price_lock_time'),

    volumeUsg: doublePrecision('volume_usg').notNull(),
    volumeMt: doublePrecision('volume_mt'),
    volumeBbls: doublePrecision('volume_bbls'),
    /** Fuel-specific. Nullable for food deals. */
    densityKgL: doublePrecision('density_kg_l'),
    volumeTolerancePct: doublePrecision('volume_tolerance_pct')
      .notNull()
      .default(0),
    /** 'fuel' (default) or 'food'. */
    lineOfBusiness: text('line_of_business').notNull().default('fuel'),
    volumeUnit: text('volume_unit').notNull().default('usg'),
    /** Food-specific lead time + cold-chain flags. */
    productionLeadTimeWeeks: integer('production_lead_time_weeks'),
    coldChainRequired: boolean('cold_chain_required').notNull().default(false),

    currency: dealCurrencyEnum('currency').notNull().default('usd'),
    fxRateToUsd: doublePrecision('fx_rate_to_usd').notNull().default(1),
    fxHedgeInPlace: boolean('fx_hedge_in_place').notNull().default(false),
    fxHedgeRate: doublePrecision('fx_hedge_rate'),
    fxHedgeInstrument: text('fx_hedge_instrument'),
    fxHedgeExpiry: date('fx_hedge_expiry'),

    buyerOrgId: text('buyer_org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    buyerContactId: text('buyer_contact_id').references(() => contacts.id, {
      onDelete: 'set null',
    }),
    sellerOrgId: text('seller_org_id').references(() => organizations.id, {
      onDelete: 'set null',
    }),
    intermediaryOrgId: text('intermediary_org_id').references(
      () => organizations.id,
      { onDelete: 'set null' },
    ),
    intermediaryRole: text('intermediary_role'),
    /** Two-sided brokers — buy-side and sell-side may each have own
     *  commission + payment terms. Legacy intermediary_org_id stays. */
    buySideBrokerOrgId: text('buy_side_broker_org_id').references(
      () => organizations.id,
      { onDelete: 'set null' },
    ),
    buySideBrokerCommissionPct: doublePrecision(
      'buy_side_broker_commission_pct',
    ),
    buySideBrokerPaymentTerms: text('buy_side_broker_payment_terms'),
    sellSideBrokerOrgId: text('sell_side_broker_org_id').references(
      () => organizations.id,
      { onDelete: 'set null' },
    ),
    sellSideBrokerCommissionPct: doublePrecision(
      'sell_side_broker_commission_pct',
    ),
    sellSideBrokerPaymentTerms: text('sell_side_broker_payment_terms'),

    leadId: text('lead_id').references(() => leads.id, {
      onDelete: 'set null',
    }),
    campaignId: text('campaign_id').references(() => campaigns.id, {
      onDelete: 'set null',
    }),

    laycanStart: date('laycan_start'),
    laycanEnd: date('laycan_end'),
    blDateEstimated: date('bl_date_estimated'),
    blDateActual: date('bl_date_actual'),
    etaDestination: date('eta_destination'),
    etaActual: date('eta_actual'),

    paymentTerms: paymentTermsEnum('payment_terms').notNull(),
    lcIssuingBank: text('lc_issuing_bank'),
    lcConfirmingBank: text('lc_confirming_bank'),
    lcValueUsd: doublePrecision('lc_value_usd'),
    lcExpiryDate: date('lc_expiry_date'),
    lcMarginPct: doublePrecision('lc_margin_pct'),
    sblcValueUsd: doublePrecision('sblc_value_usd'),

    tradeFinanceCostPct: doublePrecision('trade_finance_cost_pct')
      .notNull()
      .default(0),

    ofacScreeningStatus: ofacScreeningStatusEnum('ofac_screening_status')
      .notNull()
      .default('not_started'),
    bisLicenseRequired: boolean('bis_license_required')
      .notNull()
      .default(false),
    bisLicenseNumber: text('bis_license_number'),
    bisLicenseExpiry: date('bis_license_expiry'),
    eeiFilingRequired: boolean('eei_filing_required').notNull().default(false),
    eeiItn: text('eei_itn'),
    complianceHold: boolean('compliance_hold').notNull().default(false),
    complianceNotes: text('compliance_notes'),

    /** Commercial-protection state for the broker workflow (per Cole's
     *  prioritization notes #4 + #15 + #16). Surfaces in the
     *  /deals/[id] Compliance tab. `disclosure_allowed` is the
     *  hard gate — chat tools refuse to disclose buyer/seller identity
     *  or share documents until this is true. */
    ndaSignedAt: timestamp('nda_signed_at', { withTimezone: true }),
    ndaCounterpartyOrgId: uuid('nda_counterparty_org_id'),
    feeProtectionStatus: text('fee_protection_status'),
    feeProtectionProviderOrgId: uuid('fee_protection_provider_org_id'),
    disclosureAllowed: boolean('disclosure_allowed').notNull().default(false),

    counterpartyRiskScore: doublePrecision('counterparty_risk_score'),
    countryRiskScore: doublePrecision('country_risk_score'),
    politicalRiskInsured: boolean('political_risk_insured')
      .notNull()
      .default(false),

    /** Vessel pinning. Plain text — Phase 5 wires up procur's
     *  vessels (mmsi PK) once the bridge logic is decided. */
    vesselId: text('vessel_id'),
    vesselUtilizationPct: doublePrecision('vessel_utilization_pct'),
    freightRateUsdPerMt: doublePrecision('freight_rate_usd_per_mt'),
    freightRateLockedAt: timestamp('freight_rate_locked_at', {
      withTimezone: true,
    }),
    freightRateSource: text('freight_rate_source'),
    freightMarketRateAtLock: doublePrecision('freight_market_rate_at_lock'),
    demurrageRateUsdPerDay: doublePrecision('demurrage_rate_usd_per_day'),
    ballastBonusUsd: doublePrecision('ballast_bonus_usd'),
    /** "voyage" | "time" | "spot". */
    charterType: text('charter_type'),

    /** Port pinning. Plain text — Phase 5 wires to procur's ports.slug. */
    originPortId: text('origin_port_id'),
    destinationPortId: text('destination_port_id'),

    notes: text('notes'),
    internalNotes: text('internal_notes'),
    /** Procur user id (text). No FK; procur users.id is uuid. */
    createdBy: text('created_by'),
    approvedBy: text('approved_by'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    statusIdx: index('fuel_deals_status_idx').on(t.status),
    buyerIdx: index('fuel_deals_buyer_idx').on(t.buyerOrgId),
    productIdx: index('fuel_deals_product_idx').on(t.product),
    laycanIdx: index('fuel_deals_laycan_idx').on(t.laycanStart),
    createdAtIdx: index('fuel_deals_created_at_idx').on(t.createdAt),
    dealRefIdx: index('fuel_deals_deal_ref_idx').on(t.dealRef),
    vesselIdx: index('fuel_deals_vessel_idx').on(t.vesselId),
    originPortIdx: index('fuel_deals_origin_port_idx').on(t.originPortId),
    destinationPortIdx: index('fuel_deals_destination_port_idx').on(
      t.destinationPortId,
    ),
  }),
);

export type FuelDeal = typeof fuelDeals.$inferSelect;
export type NewFuelDeal = typeof fuelDeals.$inferInsert;
