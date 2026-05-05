/**
 * @procur/catalog — public-catalog query layer + AI tool registry
 * shared by the Discover widget and the main app's assistant.
 *
 * Re-exports everything via three named submodules:
 *   - queries.ts: SQL helpers (listOpportunities, pricingIntel, …)
 *   - mutations.ts: write helpers (createAlertProfile, addOpportunityToPursuit)
 *   - tools.ts: AI tool registry factory + URL helpers
 *
 * Apps that only need the tools can import from `@procur/catalog/tools`.
 */
export * from './queries';
export * from './mutations';
export {
  buildCatalogTools,
  buildFilterUrl,
  describeFilters,
  DISCOVER_BASE,
} from './tools';
export {
  evaluateTargetPrice,
  evaluateMultiProductRfq,
  type ProductSlug,
  type EvaluateTargetPriceInput,
  type EvaluateTargetPriceResult,
  type RfqLine,
  type Verdict,
} from './plausibility';
export {
  recommendVesselClass,
  inferVesselClass,
  VESSEL_CLASSES,
  type VesselClass,
  type VesselClassSlug,
  type VesselClassFit,
  type VesselRecommendation,
  type VoyageRouteType,
} from './vessels';
export {
  refinerySlateCapabilitySchema,
  readSlateCapability,
  type RefinerySlateCapability,
} from './slate-capability';
export {
  customsContextSchema,
  readCustomsContext,
  type CustomsContextMapping,
} from './customs-context';
export {
  ENVIRONMENTAL_SERVICES_ROLE,
  WASTE_TYPES,
  TREATMENT_TECHNOLOGIES,
  REGULATOR_AUTHORITIES,
  type WasteType,
  type TreatmentTechnology,
  type EnvironmentalServicesCapability,
} from './environmental-services-taxonomy';
export {
  FUEL_BUYER_ROLE,
  FUEL_BUYER_SEGMENTS,
  FUEL_TYPES_PURCHASED,
  PROCUREMENT_MODELS,
  PROCUREMENT_AUTHORITIES,
  PAYMENT_INSTRUMENTS,
  OWNERSHIP_TYPES,
  VOLUME_CONFIDENCE_LEVELS,
  type FuelBuyerSegment,
  type FuelTypePurchased,
  type ProcurementModel,
  type ProcurementAuthority,
  type PaymentInstrument,
  type OwnershipType,
  type VolumeConfidence,
  type FuelBuyerProfile,
} from './fuel-buyer-taxonomy';
