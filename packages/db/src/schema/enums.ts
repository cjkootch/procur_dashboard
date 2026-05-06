import { pgEnum } from 'drizzle-orm/pg-core';

export const planTierEnum = pgEnum('plan_tier', ['free', 'pro', 'team', 'enterprise']);

export const userRoleEnum = pgEnum('user_role', ['owner', 'admin', 'member', 'viewer']);

export const opportunityStatusEnum = pgEnum('opportunity_status', [
  'active',
  'closed',
  'awarded',
  'cancelled',
]);

export const pursuitStageEnum = pgEnum('pursuit_stage', [
  'identification',
  'qualification',
  'capture_planning',
  'proposal_development',
  'submitted',
  'awarded',
  'lost',
]);

export const proposalStatusEnum = pgEnum('proposal_status', [
  'drafting',
  'outline_ready',
  'in_review',
  'finalized',
  'submitted',
]);

export const contractStatusEnum = pgEnum('contract_status', ['active', 'completed', 'terminated']);

export const contractTierEnum = pgEnum('contract_tier', ['prime', 'subcontract', 'task_order']);

export const scraperRunStatusEnum = pgEnum('scraper_run_status', [
  'running',
  'success',
  'failed',
  'partial',
]);

export const alertFrequencyEnum = pgEnum('alert_frequency', ['instant', 'daily', 'weekly']);

export const regionEnum = pgEnum('region', ['caribbean', 'latam', 'africa', 'global']);

// ============================================================================
// Vex-merge enums (Phase 1 — see docs/vex-into-procur-merge-brief.md)
// ============================================================================
// Ported from vex's @vex/domain consts. Values are inlined as string
// literals so procur doesn't depend on @vex/* namespaces. userRoleEnum
// is reused — vex's values match procur's existing one.

export const recordStatusEnum = pgEnum('record_status', [
  'active',
  'inactive',
  'archived',
]);

export const leadStatusEnum = pgEnum('lead_status', [
  'new',
  'qualified',
  'disqualified',
  'won',
  'lost',
]);

export const campaignStatusEnum = pgEnum('campaign_status', [
  'active',
  'paused',
  'completed',
  'archived',
]);

export const messageDirectionEnum = pgEnum('message_direction', [
  'inbound',
  'outbound',
]);

export const rawEventStatusEnum = pgEnum('raw_event_status', [
  'pending',
  'processed',
  'failed',
]);

export const agentRunStatusEnum = pgEnum('agent_run_status', [
  'pending',
  'running',
  'completed',
  'failed',
]);

export const approvalDecisionEnum = pgEnum('approval_decision', [
  'pending',
  'approved',
  'rejected',
  'auto_approved',
]);

export const dealStatusEnum = pgEnum('deal_status', [
  'draft',
  'negotiating',
  'pending_approval',
  'approved',
  'loading',
  'in_transit',
  'delivered',
  'settled',
  'cancelled',
  'failed',
]);

export const dealTypeEnum = pgEnum('deal_type', [
  'spot',
  'program',
  'tender',
  'spot_with_option',
]);

export const productTypeEnum = pgEnum('product_type', [
  'ulsd',
  'gasoline_87',
  'gasoline_91',
  'jet_a',
  'jet_a1',
  'avgas',
  'lfo',
  'hfo',
  'lng',
  'lpg',
  'biodiesel_b20',
  'rice',
  'beans',
  'pork',
  'chicken',
  'cooking_oil',
  'powdered_milk',
]);

export const incotermEnum = pgEnum('incoterm', [
  'fob',
  'cif',
  'cfr',
  'dap',
  'exw',
  'fas',
]);

export const pricingBasisEnum = pgEnum('pricing_basis', [
  'platts',
  'argus',
  'opis',
  'nymex_wti',
  'nymex_rbob',
  'ice_brent',
  'fixed',
  'negotiated',
]);

export const paymentTermsEnum = pgEnum('payment_terms', [
  'prepayment_100',
  'prepayment_80_20',
  'lc_sight',
  'lc_60d',
  'lc_90d',
  'lc_120d',
  'sblc',
  'open_account',
  'telegraphic_transfer',
  'mixed',
]);

export const dealCurrencyEnum = pgEnum('deal_currency', [
  'usd',
  'eur',
  'cad',
  'jmd',
  'ttd',
  'dop',
  'bbd',
  'xcd',
]);

export const vesselTypeEnum = pgEnum('vessel_type', [
  'tanker_mr',
  'tanker_lr1',
  'tanker_lr2',
  'tanker_vlcc',
  'barge',
  'coastal_tanker',
  'isocontainer',
  'flexitank',
]);

/**
 * Broader hull classification used by freight_rates. Distinct from
 * vesselTypeEnum — that one is pinned to refined-product tankers /
 * ISO containers; this one covers bulk + container + reefer tonnage
 * for charter-rate benchmarking.
 */
export const vesselClassEnum = pgEnum('vessel_class', [
  'handysize',
  'handymax',
  'panamax',
  'aframax',
  'suezmax',
  'vlcc',
  'mr_tanker',
  'lr1',
  'lr2',
  'coastal',
  'barge',
  'container',
  'reefer',
  'bulk_carrier',
]);

export const freightBasisEnum = pgEnum('freight_basis', [
  'per_usg',
  'lump_sum',
  'worldscale',
  'time_charter_eq',
]);

export const ofacScreeningStatusEnum = pgEnum('ofac_screening_status', [
  'not_started',
  'in_progress',
  'cleared',
  'flagged',
  'rejected',
]);

export const scenarioTypeEnum = pgEnum('scenario_type', [
  'base',
  'conservative',
  'aggressive',
  'stress',
  'custom',
]);

export const cashflowDirectionEnum = pgEnum('cashflow_direction', [
  'inflow',
  'outflow',
]);

export const cashflowEventTypeEnum = pgEnum('cashflow_event_type', [
  'buyer_prepayment',
  'buyer_final_payment',
  'lc_payment',
  'product_purchase',
  'freight_payment',
  'freight_deposit',
  'insurance_premium',
  'port_fees',
  'compliance_fees',
  'bank_fees',
  'intermediary_fee',
  'storage_fees',
  'demurrage',
  'overhead',
  'custom',
]);

export const cashflowBaseTypeEnum = pgEnum('cashflow_base_type', [
  'revenue',
  'product_cost',
  'freight',
  'insurance',
  'port_handling',
  'compliance',
  'finance',
  'overhead',
  'custom',
]);

export const dealDocumentTypeEnum = pgEnum('deal_document_type', [
  'term_sheet',
  'loi',
  'spa',
  'lc',
  'sblc',
  'bl',
  'coa',
  'q88',
  'inspection_report',
  'ofac_screening',
  'bis_license',
  'eei',
  'insurance_cert',
  'customs_entry',
  'invoice',
  'packing_list',
  'sddr',
  'other',
]);

export const counterpartyRiskTierEnum = pgEnum('counterparty_risk_tier', [
  'tier_1',
  'tier_2',
  'tier_3',
  'watch',
  'declined',
]);

export type VesselClass = (typeof vesselClassEnum.enumValues)[number];
