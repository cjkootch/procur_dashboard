/**
 * Trade structure reference taxonomies — the controlled vocabularies
 * that drive `deal_structure_templates` and `commission_structures`
 * column values + assistant-tool input validation. Spec:
 * docs/deal-structures-catalog-brief.md §5.
 *
 * Pattern mirrors environmental-services-taxonomy.ts: const arrays
 * exported as `as const` so they double as TypeScript types and as
 * Zod-friendly enums for the chat-tool schemas.
 */

// ─── Incoterms 2020 ───────────────────────────────────────────────

/**
 * The relevant Incoterms for VTC's deal universe. DES is technically
 * deprecated in Incoterms 2020 but still used in many crude markets;
 * captured here because real conversations reference it.
 */
export const INCOTERMS_2020 = [
  'EXW',
  'FCA',
  'FAS',
  'FOB',
  'CFR',
  'CIF',
  'CIP',
  'DAP',
  'DPU',
  'DDP',
  'DES',
] as const;
export type Incoterm = (typeof INCOTERMS_2020)[number];

// ─── Payment instruments ──────────────────────────────────────────

export const PAYMENT_INSTRUMENTS = [
  'lc-sight',
  'lc-deferred-30',
  'lc-deferred-60',
  'lc-deferred-90',
  'lc-deferred-180',
  'cad',
  'tt-prepayment',
  'tt-against-docs',
  'sblc-backed',
  'open-account',
  'escrow',
  'documentary-collection',
] as const;
export type PaymentInstrument = (typeof PAYMENT_INSTRUMENTS)[number];

// ─── Insurance + inspection ───────────────────────────────────────

export const CARGO_INSURANCE_CLAUSES = [
  'institute-cargo-clauses-a',
  'institute-cargo-clauses-b',
  'institute-cargo-clauses-c',
  'all-risks-marine',
  'war-risks-included',
  'buyer-arranged',
] as const;
export type CargoInsuranceClause = (typeof CARGO_INSURANCE_CLAUSES)[number];

export const INSPECTION_TYPES = [
  'sgs-loadport',
  'sgs-discharge',
  'sgs-both',
  'bv-loadport',
  'bv-discharge',
  'bv-both',
  'intertek-loadport',
  'intertek-discharge',
  'caleb-brett-loadport',
  'cargo-inspection-by-buyer',
  'none',
] as const;
export type InspectionType = (typeof INSPECTION_TYPES)[number];

// ─── Geographic regions ───────────────────────────────────────────

export const REGIONS = [
  'caribbean',
  'latam-mainland',
  'mediterranean',
  'west-africa',
  'east-africa',
  'middle-east-gulf',
  'south-asia',
  'southeast-asia',
  'east-asia',
  'us-gulf-coast',
  'us-domestic',
  'canada',
  'eu-ports',
  'baltic',
  'global',
] as const;
export type Region = (typeof REGIONS)[number];

// ─── VTC entity separation ────────────────────────────────────────

/**
 * The five operating entities under the entity-separation discipline
 * from specialty-crude-strategy.md §6.1. Every template + commission
 * structure must specify exactly one — no ambiguity about which entity
 * executes a given deal.
 */
export const VTC_ENTITIES = [
  'vtc-llc',
  'vector-antilles',
  'vector-auto-exports',
  'vector-food-fund',
  'stabroek-advisory',
] as const;
export type VtcEntity = (typeof VTC_ENTITIES)[number];

// ─── Deal-template categorization ─────────────────────────────────

export const DEAL_CATEGORIES = [
  'refined-product',
  'specialty-crude',
  'crude-conventional',
  'food-commodity',
  'vehicle',
  'lng',
  'lpg',
] as const;
export type DealCategory = (typeof DEAL_CATEGORIES)[number];

// ─── Standard documents ───────────────────────────────────────────

/**
 * Order matters — represents typical bank presentation sequence at
 * settlement. Templates' `standardDocuments` arrays should preserve
 * this ordering.
 */
export const STANDARD_DOCUMENTS = [
  'commercial-invoice',
  'bill-of-lading-3-of-3-originals',
  'certificate-of-origin',
  'sgs-quality-certificate',
  'sgs-quantity-certificate',
  'bv-quality-certificate',
  'packing-list',
  'beneficiary-certificate',
  'phytosanitary-certificate',
  'fumigation-certificate',
  'cargo-manifest',
  'mate-receipt',
  'export-license',
  'insurance-policy',
  'flag-state-certificate',
  'vehicle-vin-list',
  'vehicle-export-permit',
  'sds-msds',
  'tank-experience-cert',
  'load-port-survey',
  'discharge-port-survey',
] as const;
export type StandardDocument = (typeof STANDARD_DOCUMENTS)[number];

// ─── Margin + lifecycle ───────────────────────────────────────────

export const MARGIN_STRUCTURES = [
  'fixed-spread-per-unit',
  'pct-of-revenue',
  'cost-plus-pct',
  'floating-with-floor',
  'commission-only',
  'back-to-back-flat',
] as const;
export type MarginStructure = (typeof MARGIN_STRUCTURES)[number];

export const MARGIN_UNITS = [
  'pct',
  'usd-per-mt',
  'usd-per-bbl',
  'usd-per-shipment',
] as const;
export type MarginUnit = (typeof MARGIN_UNITS)[number];

export const LAYCAN_WINDOWS = [
  'narrow-3-day',
  'standard-5-day',
  'wide-7-day',
  'wide-10-day',
] as const;
export type LaycanWindow = (typeof LAYCAN_WINDOWS)[number];

export const TEMPLATE_STATUSES = ['active', 'draft', 'deprecated', 'archived'] as const;
export type TemplateStatus = (typeof TEMPLATE_STATUSES)[number];

// ─── Commission structure vocabularies ────────────────────────────

export const COMMISSION_CATEGORIES = [
  'origination-partner',
  'intermediary-broker',
  'sub-broker',
  'finder-fee',
  'introducer',
  'consultant',
  'sole-and-exclusive-broker',
] as const;
export type CommissionCategory = (typeof COMMISSION_CATEGORIES)[number];

export const PARTY_RELATIONSHIPS = [
  'vtc-pays-third-party',
  'vtc-receives-from-third-party',
  'split-with-third-party',
] as const;
export type PartyRelationship = (typeof PARTY_RELATIONSHIPS)[number];

export const COMMISSION_BASIS_TYPES = [
  'pct-of-net-margin',
  'pct-of-gross-revenue',
  'usd-per-unit',
  'flat-fee-per-deal',
  'flat-fee-per-lifting',
  'tiered-by-volume',
  'tiered-by-margin',
  'success-fee-only',
] as const;
export type CommissionBasisType = (typeof COMMISSION_BASIS_TYPES)[number];

export const COMMISSION_TRIGGER_EVENTS = [
  'on-contract-signature',
  'on-first-lifting',
  'on-each-lifting',
  'on-payment-received',
  'on-deal-completion',
  'pari-passu-with-margin',
] as const;
export type CommissionTriggerEvent = (typeof COMMISSION_TRIGGER_EVENTS)[number];

export const COMMISSION_PAYMENT_TIMINGS = [
  'within-7-days',
  'within-14-days',
  'within-30-days',
  'within-60-days',
  'pari-passu-with-margin',
  'on-quarterly-cycle',
  'on-annual-true-up',
] as const;
export type CommissionPaymentTiming = (typeof COMMISSION_PAYMENT_TIMINGS)[number];

// ─── FeeStructure JSONB schemas ───────────────────────────────────

/**
 * Polymorphic fee-structure shapes per `commission_structures.basisType`.
 * Validation is done in the TypeScript layer rather than via a DB-level
 * CHECK constraint because the JSONB shape varies and DB constraints
 * can't easily express discriminated unions.
 *
 * Use FEE_STRUCTURE_SHAPE_BY_BASIS as the single source of truth
 * mapping basis type → expected JSON keys. The chat tool + UI both
 * read from this when rendering or composing fee-structure JSON.
 */
export type FeeStructurePctOfMargin = { partyShare: number };
export type FeeStructurePctOfRevenue = { partyShare: number };
export type FeeStructureUsdPerUnit = { amountUsd: number; unit: 'bbl' | 'mt' | 'cargo' };
export type FeeStructureFlatPerDeal = { amountUsd: number };
export type FeeStructureFlatPerLifting = { amountUsd: number };
export type FeeStructureTieredByVolume = {
  tiers: Array<{
    minVolume: number;
    maxVolume: number | null;
    ratePerUnit: number;
    unit: 'bbl' | 'mt' | 'cargo';
  }>;
};
export type FeeStructureTieredByMargin = {
  tiers: Array<{
    minMarginPct: number;
    maxMarginPct: number | null;
    partyShare: number;
  }>;
};
export type FeeStructureSuccessFeeOnly = {
  triggerCondition: string;
  amountUsd?: number;
  partyShare?: number;
};

export type FeeStructure =
  | FeeStructurePctOfMargin
  | FeeStructurePctOfRevenue
  | FeeStructureUsdPerUnit
  | FeeStructureFlatPerDeal
  | FeeStructureFlatPerLifting
  | FeeStructureTieredByVolume
  | FeeStructureTieredByMargin
  | FeeStructureSuccessFeeOnly;

/**
 * Required keys per basisType — caller validates fee_structure JSONB
 * against this map before persisting.
 */
export const FEE_STRUCTURE_REQUIRED_KEYS: Record<CommissionBasisType, readonly string[]> = {
  'pct-of-net-margin': ['partyShare'],
  'pct-of-gross-revenue': ['partyShare'],
  'usd-per-unit': ['amountUsd', 'unit'],
  'flat-fee-per-deal': ['amountUsd'],
  'flat-fee-per-lifting': ['amountUsd'],
  'tiered-by-volume': ['tiers'],
  'tiered-by-margin': ['tiers'],
  'success-fee-only': ['triggerCondition'],
};

// ─── Currency vocabularies ────────────────────────────────────────

/**
 * Common ISO 4217 codes that surface in templates. Templates can
 * specify any valid ISO 4217 — this list is the curated subset
 * referenced in seed data.
 */
export const COMMON_PAYMENT_CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY', 'CNY', 'AED'] as const;
export type CommonPaymentCurrency = (typeof COMMON_PAYMENT_CURRENCIES)[number];
