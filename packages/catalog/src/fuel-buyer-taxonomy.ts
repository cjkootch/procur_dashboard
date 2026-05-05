/**
 * Caribbean fuel buyer category — taxonomy reference data and type
 * definitions. Spec lives in `docs/caribbean-fuel-buyer-brief.md` §3.
 *
 * Five constants drive the structured slot on
 * `known_entities.metadata.fuelBuyerProfile` for any entity whose
 * role is `'fuel-buyer-industrial'`:
 *
 *   - `FUEL_BUYER_SEGMENTS`     — 24-segment classification taxonomy
 *   - `FUEL_TYPES_PURCHASED`    — finished products bought at cargo scale
 *   - `PROCUREMENT_MODELS`      — how the entity buys (term / spot / hybrid)
 *   - `PAYMENT_INSTRUMENTS`     — what payment shapes the buyer can clear
 *   - `OWNERSHIP_TYPES`         — state-owned / private / multinational sub
 *
 * `role` is free-text on `known_entities`, so adding
 * `'fuel-buyer-industrial'` requires no migration. Same pattern as
 * the env-services category.
 */

/** Free-text role marker for cargo-scale industrial fuel buyers. */
export const FUEL_BUYER_ROLE = 'fuel-buyer-industrial' as const;

/**
 * Primary segment classification per brief §3. Multi-select supported
 * — some entities span segments (e.g. a state utility that also
 * runs aviation fueling at the airport).
 *
 * Add a new value when an actual buyer surfaces that doesn't map to
 * one of these. Resist adding overly granular sub-categories — 24 is
 * already wide enough that picker UX needs care.
 */
export const FUEL_BUYER_SEGMENTS = [
  // Utilities
  'utility-power-generation',
  'utility-water-desalination',
  // Mining
  'mining-bauxite-alumina',
  'mining-nickel',
  'mining-gold',
  'mining-other',
  // Marine
  'marine-bunker-supplier',
  'marine-cruise-line-fueling',
  // Aviation
  'aviation-fuel-handler',
  'aviation-airline-direct',
  // Agriculture
  'agricultural-cooperative',
  'agricultural-large-estate',
  // Industrial
  'industrial-distributor',
  'industrial-construction-contractor',
  'industrial-cement-aggregate',
  'industrial-manufacturing',
  // Government
  'government-military',
  'government-public-works',
  'government-public-transport',
  // Hospitality
  'hospitality-hotel-resort',
  'hospitality-cruise-line-corporate',
  // Retail / LPG / niche
  'retail-distributor-network',
  'lpg-distributor',
  'forestry-logging',
  'fishing-fleet-operator',
] as const;
export type FuelBuyerSegment = (typeof FUEL_BUYER_SEGMENTS)[number];

/**
 * Finished products purchased at cargo scale. Distinct from
 * crude-grade vocabulary (which lives in
 * `crude-grades` table) — these are the product-side fuels traded
 * into Caribbean markets.
 */
export const FUEL_TYPES_PURCHASED = [
  // Gasolines
  'gasoline-87',
  'gasoline-90',
  'gasoline-95',
  // Diesels
  'diesel-ulsd',
  'diesel-lsd',
  'diesel-marine-gasoil',
  // Aviation
  'jet-a-1',
  'jet-jp8',
  'avgas-100ll',
  // Residual / bunker
  'hfo-380cst',
  'hfo-180cst',
  'vlsfo',
  'lsmgo',
  // Distillates / specialty
  'kerosene',
  'lpg-propane',
  'lpg-butane',
  'asphalt',
  'bitumen',
] as const;
export type FuelTypePurchased = (typeof FUEL_TYPES_PURCHASED)[number];

export const PROCUREMENT_MODELS = [
  'term-contract-dominant',
  'spot-dominant',
  'hybrid',
  'tender-only',
  'unknown',
] as const;
export type ProcurementModel = (typeof PROCUREMENT_MODELS)[number];

export const PROCUREMENT_AUTHORITIES = [
  'centralized',
  'regional',
  'facility-level',
  'unknown',
] as const;
export type ProcurementAuthority = (typeof PROCUREMENT_AUTHORITIES)[number];

/**
 * Payment instruments the buyer can clear. Drives match-cargo-to-
 * buyer logic — a small distributor without LC capability can't
 * be matched to a cargo whose seller demands LC.
 */
export const PAYMENT_INSTRUMENTS = [
  'lc-sight',
  'lc-deferred',
  'cad',
  'tt-prepayment',
  'tt-against-docs',
  'open-account',
  'escrow',
  'sblc-backed',
] as const;
export type PaymentInstrument = (typeof PAYMENT_INSTRUMENTS)[number];

export const OWNERSHIP_TYPES = [
  'state-owned',
  'state-adjacent',
  'private-domestic',
  'multinational-subsidiary',
  'cooperative',
  'unknown',
] as const;
export type OwnershipType = (typeof OWNERSHIP_TYPES)[number];

/**
 * Annual-purchase-volume confidence flag. The buyer rolodex carries
 * volume estimates — distinguishing hard public disclosures from
 * order-of-magnitude estimates is necessary for downstream tools
 * that match cargo against demand.
 */
export const VOLUME_CONFIDENCE_LEVELS = [
  'public-disclosure',
  'estimated-from-capacity',
  'estimated-from-industry-norms',
  'unknown',
] as const;
export type VolumeConfidence = (typeof VOLUME_CONFIDENCE_LEVELS)[number];

/**
 * Per-entity buyer profile stored at
 * `known_entities.metadata.fuelBuyerProfile`. Lives in `metadata`
 * (jsonb) so no schema migration is needed. Readers narrow at
 * access time; partial entries during Phase 1 / 2 ingest are
 * expected.
 */
export interface FuelBuyerProfile {
  segments: FuelBuyerSegment[];
  fuelTypesPurchased: FuelTypePurchased[];

  /** Annual purchase volume in barrels. Both bounds optional —
   *  some entities are well-disclosed (utility annual reports),
   *  others are estimates from capacity or industry norms. */
  annualPurchaseVolumeBblMin: number | null;
  annualPurchaseVolumeBblMax: number | null;
  annualPurchaseVolumeConfidence: VolumeConfidence;

  /** Typical cargo size in metric tonnes when buying at cargo
   *  scale. Drives match-cargo logic: a buyer whose typical cargo
   *  is 5k-10k MT can't take a 30k MT Aframax in one shot. */
  typicalCargoSizeMt: { min: number; max: number } | null;

  procurementModel: ProcurementModel;
  procurementAuthority: ProcurementAuthority;

  /** Existing supplier relationships where publicly disclosed. */
  knownSuppliers: string[];

  /** Caribbean countries the entity operates in (ISO-2). */
  caribbeanCountriesOperated: string[];

  /** Country where procurement decisions actually happen — may
   *  differ from operational country for multinational
   *  subsidiaries (e.g. cruise line fueling decided in Miami). */
  decisionMakerCountry: string | null;

  paymentInstrumentCapability: PaymentInstrument[];

  /** Banks the entity uses where publicly disclosed. Useful for
   *  OFAC pre-screening and LC routing. */
  knownBanks: string[];

  ownershipType: OwnershipType;

  /** Tier-1: top buyers in segment, engage proactively.
   *  Tier-2: meaningful but less mapped, opportunistic.
   *  Tier-3: smaller / less validated, track. */
  tier: 1 | 2 | 3 | null;

  /** Primary procurement contact, if known. Layered into
   *  entity_contact_enrichments via Phase 3. */
  primaryContactRole: string | null;
  primaryContactName: string | null;

  notes: string;
  /** 0.0-1.0 trust score. Higher when multi-source verified. */
  confidenceScore: number;
}
