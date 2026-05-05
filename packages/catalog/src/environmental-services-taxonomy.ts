/**
 * Environmental services category — taxonomy reference data and
 * type definitions. Spec lives in
 * `docs/environmental-services-rolodex-brief.md` §3.
 *
 * Three constants drive the structured slots on
 * `known_entities.metadata.environmentalServices` for any entity
 * whose role is `'environmental-services'`:
 *
 *   - `WASTE_TYPES`            — what the operator handles
 *   - `TREATMENT_TECHNOLOGIES` — how the operator handles it
 *   - `REGULATOR_AUTHORITIES`  — issuing authorities for the
 *                                regulator-license layer that
 *                                distinguishes this rolodex from a
 *                                generic vendor directory
 *
 * `role` itself is free-text on `known_entities` (see schema —
 * column is `text`), so adding `'environmental-services'` as a
 * value requires no migration. The brief's §4.5 mentions
 * `0061_environmental_services_role.sql` as a "if enforced at DB
 * level (otherwise text validation only)" — text validation only
 * applies, so no migration ships in this PR.
 */

/** Free-text role marker for environmental services entities. */
export const ENVIRONMENTAL_SERVICES_ROLE = 'environmental-services' as const;

/**
 * Petroleum-relevant waste streams. Drawn from the upstream /
 * downstream petroleum waste universe (drilling residues, oily
 * sludge, refinery sludge, NORM, contaminated soil); not all-
 * encompassing of every hazardous waste type.
 *
 * Add a new value when a regulator registry surfaces a stream that
 * doesn't map to one of these — but resist adding overly granular
 * sub-categories. Slate of 14 should cover ~95 % of operator-
 * relevant requests.
 */
export const WASTE_TYPES = [
  'drilling-mud-water-based',
  'drilling-mud-oil-based',
  'drilling-mud-synthetic-based',
  'drill-cuttings',
  'oily-sludge',
  'tank-bottoms',
  'pit-waste',
  'produced-water-sludge',
  'refinery-sludge',
  'contaminated-soil',
  'hydrocarbon-contaminated-water',
  'spent-catalysts',
  /** Naturally occurring radioactive material — pipescale, sludges
   *  from upstream production. Distinct license requirements in
   *  most jurisdictions. */
  'naturally-occurring-radioactive-material',
  'crude-spill-residue',
] as const;
export type WasteType = (typeof WASTE_TYPES)[number];

/**
 * Treatment technologies the operator deploys. Multi-select —
 * most operators run several technologies (e.g. centrifugation +
 * thermal desorption + landfarming for a diversified operator).
 */
export const TREATMENT_TECHNOLOGIES = [
  'thermal-desorption',
  'bioremediation',
  'solidification-stabilization',
  'chemical-treatment',
  'centrifugation',
  'cuttings-dryer',
  'shale-shaker-recycling',
  'oil-water-separation',
  'incineration',
  'co-processing-cement-kiln',
  'landfarming',
  'encapsulation',
  'distillation-recovery',
] as const;
export type TreatmentTechnology = (typeof TREATMENT_TECHNOLOGIES)[number];

/**
 * Issuing authorities for the regulator-license layer. Each entry
 * captures the country (ISO-2) and the canonical short name we
 * normalize to in the rolodex.
 *
 * The `code` is what we store in
 * `regulatorLicenses[].authority` — keep it stable. Add new
 * authorities here as Phase 2 ingestion surfaces them; do not
 * fold provincial / regional registries into the parent national
 * authority (CAR Cundinamarca is distinct from ANLA — they license
 * different operator scopes).
 */
export const REGULATOR_AUTHORITIES: ReadonlyArray<{
  code: string;
  country: string;
  fullName: string;
  scope: 'federal' | 'state' | 'regional';
}> = [
  // Mexico
  { code: 'SEMARNAT', country: 'MX', fullName: 'Secretaría de Medio Ambiente y Recursos Naturales', scope: 'federal' },
  // Brazil
  { code: 'IBAMA', country: 'BR', fullName: 'Instituto Brasileiro do Meio Ambiente — CTF/APP', scope: 'federal' },
  // Colombia — federal + the priority regional CARs
  { code: 'ANLA', country: 'CO', fullName: 'Autoridad Nacional de Licencias Ambientales', scope: 'federal' },
  { code: 'CAR-Cundinamarca', country: 'CO', fullName: 'Corporación Autónoma Regional de Cundinamarca', scope: 'regional' },
  { code: 'Cormacarena', country: 'CO', fullName: 'Corporación para el Desarrollo Sostenible del Área de Manejo Especial La Macarena', scope: 'regional' },
  { code: 'Corporinoquia', country: 'CO', fullName: 'Corporación Autónoma Regional de la Orinoquia', scope: 'regional' },
  { code: 'CDMB', country: 'CO', fullName: 'Corporación Autónoma Regional para la Defensa de la Meseta de Bucaramanga', scope: 'regional' },
  { code: 'Corantioquia', country: 'CO', fullName: 'Corporación Autónoma Regional del Centro de Antioquia', scope: 'regional' },
  // Argentina — provincial
  { code: 'AR-Neuquen', country: 'AR', fullName: 'Secretaría de Ambiente de la Provincia de Neuquén', scope: 'state' },
  { code: 'AR-Mendoza', country: 'AR', fullName: 'Secretaría de Ambiente de la Provincia de Mendoza', scope: 'state' },
  { code: 'AR-Chubut', country: 'AR', fullName: 'Ministerio de Ambiente de la Provincia de Chubut', scope: 'state' },
  { code: 'AR-Santa-Cruz', country: 'AR', fullName: 'Secretaría de Ambiente de la Provincia de Santa Cruz', scope: 'state' },
  { code: 'AR-Buenos-Aires', country: 'AR', fullName: 'Organismo Provincial para el Desarrollo Sostenible (OPDS)', scope: 'state' },
  // Other LatAm
  { code: 'OEFA', country: 'PE', fullName: 'Organismo de Evaluación y Fiscalización Ambiental', scope: 'federal' },
  { code: 'MAATE', country: 'EC', fullName: 'Ministerio del Ambiente, Agua y Transición Ecológica', scope: 'federal' },
  { code: 'EMA', country: 'TT', fullName: 'Environmental Management Authority', scope: 'federal' },
  { code: 'GY-EPA', country: 'GY', fullName: 'Environmental Protection Agency (Guyana)', scope: 'federal' },
  // United States
  { code: 'EPA-RCRA', country: 'US', fullName: 'EPA Resource Conservation and Recovery Act registry', scope: 'federal' },
];

/**
 * Per-entity capability shape stored at
 * `known_entities.metadata.environmentalServices`. Lives in `metadata`
 * (jsonb) so no schema migration is needed; readers narrow the
 * envelope at access time.
 *
 * `confidenceScore` is the rolodex-entry trust score — higher when
 * the entry was verified through multiple sources (regulator
 * registry + company website + named client disclosure). Used by
 * the chat tools' `minConfidenceScore` filter.
 */
export interface EnvironmentalServicesCapability {
  wasteTypesHandled: WasteType[];
  treatmentTechnologies: TreatmentTechnology[];
  /** Operator can deploy mobile units to the project site rather
   *  than requiring waste transport to a fixed facility. */
  mobileCapability: boolean;
  /** Operator runs (or partners with) certified labs for waste
   *  characterization. */
  labCapability: boolean;
  /** ISO-2 country codes where the operator has documented
   *  operational presence. */
  countriesServed: string[];
  /** Regulator licenses held — the verifiable-licensure layer that
   *  distinguishes rolodex entries from generic vendor directories. */
  regulatorLicenses: Array<{
    authority: string;
    country: string;
    licenseCategory: string;
    licenseNumber: string | null;
    /** ISO date or null when not published. */
    validUntil: string | null;
    sourceUrl: string;
  }>;
  /** Named oil & gas operators publicly disclosed as prior clients. */
  priorOilGasClients: string[];
  /** Free-text capability nuance — proprietary tech, geographic
   *  strengths, recent project examples. */
  notes: string;
  /** 0.0-1.0 rolodex-entry trust score. */
  confidenceScore: number;
}
