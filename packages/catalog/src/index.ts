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
  PAYMENT_INSTRUMENTS as FUEL_BUYER_PAYMENT_INSTRUMENTS,
  OWNERSHIP_TYPES,
  VOLUME_CONFIDENCE_LEVELS,
  type FuelBuyerSegment,
  type FuelTypePurchased,
  type ProcurementModel,
  type ProcurementAuthority,
  type PaymentInstrument as FuelBuyerPaymentInstrument,
  type OwnershipType,
  type VolumeConfidence,
  type FuelBuyerProfile,
} from './fuel-buyer-taxonomy';
export {
  INCOTERMS_2020,
  PAYMENT_INSTRUMENTS,
  CARGO_INSURANCE_CLAUSES,
  INSPECTION_TYPES,
  REGIONS,
  VTC_ENTITIES,
  DEAL_CATEGORIES,
  STANDARD_DOCUMENTS,
  MARGIN_STRUCTURES,
  MARGIN_UNITS,
  LAYCAN_WINDOWS,
  TEMPLATE_STATUSES,
  COMMISSION_CATEGORIES,
  PARTY_RELATIONSHIPS,
  COMMISSION_BASIS_TYPES,
  COMMISSION_TRIGGER_EVENTS,
  COMMISSION_PAYMENT_TIMINGS,
  FEE_STRUCTURE_REQUIRED_KEYS,
  COMMON_PAYMENT_CURRENCIES,
  type Incoterm,
  type PaymentInstrument,
  type CargoInsuranceClause,
  type InspectionType,
  type Region,
  type VtcEntity,
  type DealCategory,
  type StandardDocument,
  type MarginStructure,
  type MarginUnit,
  type LaycanWindow,
  type TemplateStatus,
  type CommissionCategory,
  type PartyRelationship,
  type CommissionBasisType,
  type CommissionTriggerEvent,
  type CommissionPaymentTiming,
  type FeeStructure,
  type FeeStructurePctOfMargin,
  type FeeStructurePctOfRevenue,
  type FeeStructureUsdPerUnit,
  type FeeStructureFlatPerDeal,
  type FeeStructureFlatPerLifting,
  type FeeStructureTieredByVolume,
  type FeeStructureTieredByMargin,
  type FeeStructureSuccessFeeOnly,
} from './trade-taxonomy';
