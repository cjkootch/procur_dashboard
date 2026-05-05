# Deal Structure and Commission Catalog — Global

**Status:** spec, not yet implemented
**Owner:** Cole
**Last updated:** 2026-05-04
**Repo:** `cjkootch/procur_dashboard`
**Companion to:** `docs/strategic-vision.md` (procur as the operational backbone), `docs/commercial-strategy.md` (the niches whose structures this catalogs), `docs/specialty-crude-strategy.md` (the entity-separation discipline this catalog enforces), `docs/origination-partners-brief.md` (the partner relationships whose commissions this catalogs)

This brief specifies two new structured-data layers in procur — a deal structure template catalog and a commission structure catalog — capturing VTC's actual deal-shaping playbook globally. It also specifies the system prompt additions that give the assistant fluent vocabulary in trade structure terminology.

The catalog is **VTC's templates**, not a generic Incoterms reference. The distinction matters: a generic catalog has hundreds of theoretical entries that nobody uses; VTC's catalog has 25-40 high-value templates mapping to real commercial conversations across Caribbean fuel, specialty crude through Vector Antilles, food commodities through Vector Food Fund, and vehicle exports through Vector Auto Exports.

Total estimated effort: ~3-5 days of build time once seed data is confirmed. Smaller scope than the connections or environmental-services briefs because the schema is small and the population is hand-curated rather than ingested.

---

## 1. Why this brief exists

VTC's existing schema captures executed deals (`contracts`), proposed deals (`proposals`), and pricing logic (`pricing_models`). What it does not capture is the **deal-shaping layer that sits upstream of every proposal**: the structures VTC actually offers, with VTC's standard parameters, that get instantiated when a specific opportunity surfaces.

Without this layer, three things break operationally:

**(a)** The assistant has no grounded reference for composing proposals. When asked to draft a Caribbean diesel proposal, it must invent or pattern-match plausible-sounding terms rather than reference VTC's actual standard structure. The output is *almost* right but lacks the precision that signals operational sophistication.

**(b)** Commission and broker-fee structures live as free text in proposal documents and contract PDFs. They are not queryable, not versionable, not analyzable. When you onboard a new origination partner, there's no structured record of the commission terms; they live in the signed agreement and nowhere else.

**(c)** Deal analytics are impossible. Which structures close at what rate? Which commission arrangements correlate with closed deals? What's the typical margin range on Caribbean Refined CIF/LC versus FOB/TT? These questions can't be answered today because the structures are buried in unstructured text.

Adding this layer fixes all three at once. The structures become queryable, referenceable, and analyzable. The assistant composes more accurately. The system gets smarter about which structures actually produce closed deals.

---

## 2. Scope and non-scope

### 2.1 In scope

- A `deal_structure_templates` table capturing VTC's standard structures globally
- A `commission_structures` table capturing broker / origination partner / sub-broker fee arrangements
- TypeScript reference taxonomies for Incoterms 2020, payment instruments, insurance clauses, inspection requirements
- System prompt additions for generic trade vocabulary
- Two assistant tools for catalog lookup
- Integration with `proposals`, `pricing_models`, and `contracts` so they reference templates and commission structures by slug rather than duplicating terms in free text
- Initial population: 25-40 deal structure templates and 8-12 commission structures based on VTC's actual current and near-term operations

### 2.2 Out of scope

- **Generic Incoterms reference data in the database.** Static industry vocabulary belongs in the system prompt, not the database. The database captures *VTC's templates that use those Incoterms*, not the Incoterms themselves.
- **Theoretical structures VTC doesn't actually offer.** A catalog of every plausible combination of every Incoterm × payment instrument × jurisdiction would be hundreds of entries. The point is to capture the structures VTC uses, not the universe of possibility.
- **Deal-specific overrides on every proposal.** Templates capture the *standard* parameters; specific proposals can override individual fields when the deal warrants it. The override mechanism is in the proposal layer, not the template layer.
- **Currency conversion logic, freight rate calculations, or insurance premium math.** These are computed at proposal time using existing pricing infrastructure; the templates only capture *which* convention applies.
- **Counterparty-specific commission negotiations beyond standard structures.** Bespoke commission deals are recorded in the contract layer; the catalog captures VTC's standard structures from which bespoke deals deviate.

### 2.3 Why hand-curated, not ingested

The connections brief and the environmental-services brief both involve ingesting external data. This brief involves capturing internal knowledge. **There is no external source for "VTC's standard deal structures" — they exist only in the operator's head and in scattered contract documents.** The work is therefore hand-curation guided by the schema, not scraping or API ingestion. This makes the brief shorter than the others but no less valuable; the leverage comes from making implicit operational knowledge explicit and queryable.

---

## 3. Deal structure template schema

A new table `deal_structure_templates`:

```typescript
export const dealStructureTemplates = pgTable('deal_structure_templates', {
  id: uuid('id').primaryKey().defaultRandom(),

  /** Stable kebab-case identifier referenced from proposals,
   *  pricing models, and contracts. Examples:
   *    'caribbean-refined-cif-lc-sight'
   *    'specialty-crude-fob-origin-sblc'
   *    'food-commodity-cif-lc-sight-gafta'
   *    'vehicle-roro-cif-tt-prepayment'
   */
  slug: text('slug').notNull().unique(),

  /** Human-readable name shown in UI. */
  name: text('name').notNull(),

  /** Top-level categorization. Drives which proposal templates,
   *  which compliance flow, which entity signature applies. */
  category: text('category').notNull(),
  // Values: 'refined-product' | 'specialty-crude' | 'crude-conventional'
  //       | 'food-commodity' | 'vehicle' | 'lng' | 'lpg'

  /** Which VTC entity executes this structure. Driven by the
   *  entity-separation discipline from specialty-crude-strategy.md §6.1.
   *  No template can be ambiguous about which entity uses it. */
  vtcEntity: text('vtc_entity').notNull(),
  // Values: 'vtc-llc' | 'vector-antilles' | 'vector-auto-exports'
  //       | 'vector-food-fund' | 'stabroek-advisory'

  /** Geographic applicability — where this template is operationally
   *  valid. Templates can apply to multiple regions simultaneously. */
  applicableRegions: text('applicable_regions').array().notNull(),
  // Values: 'caribbean' | 'latam-mainland' | 'mediterranean'
  //       | 'west-africa' | 'east-africa' | 'middle-east-gulf'
  //       | 'south-asia' | 'southeast-asia' | 'east-asia'
  //       | 'us-gulf-coast' | 'us-domestic' | 'canada'
  //       | 'eu-ports' | 'baltic' | 'global'

  // === Commercial mechanics ===

  /** Incoterms 2020 designation. */
  incoterm: text('incoterm').notNull(),
  // Values: 'EXW' | 'FCA' | 'FAS' | 'FOB' | 'CFR' | 'CIF'
  //       | 'CIP' | 'DAP' | 'DPU' | 'DDP' | 'DES'
  //       (DES is technically deprecated in Incoterms 2020 but
  //        still used in many crude markets — captured here)

  /** Where title and risk transfer per the Incoterm. Free text
   *  because edge cases are common (e.g. "ship's manifold" vs
   *  "ship's rail" vs "loading flange"). */
  riskTransferPoint: text('risk_transfer_point').notNull(),

  paymentInstrument: text('payment_instrument').notNull(),
  // Values: 'lc-sight' | 'lc-deferred-30' | 'lc-deferred-60'
  //       | 'lc-deferred-90' | 'lc-deferred-180'
  //       | 'cad' | 'tt-prepayment' | 'tt-against-docs'
  //       | 'sblc-backed' | 'open-account' | 'escrow'
  //       | 'documentary-collection'

  paymentCurrency: text('payment_currency').notNull(),
  // ISO 4217: 'USD' | 'EUR' | 'GBP' | 'JPY' | 'CNY' | 'AED' | etc.

  /** Whether the template requires confirmed LC (additional bank
   *  guarantee from a confirming bank in VTC's jurisdiction).
   *  Common requirement for high-risk origin / destination pairs. */
  lcConfirmationRequired: boolean('lc_confirmation_required').default(false),

  // === Insurance and inspection ===

  cargoInsurance: text('cargo_insurance'),
  // Values: 'institute-cargo-clauses-a' | 'institute-cargo-clauses-b'
  //       | 'institute-cargo-clauses-c' | 'all-risks-marine'
  //       | 'war-risks-included' | 'buyer-arranged' | null

  /** When seller arranges insurance (CIF, CIP), which clauses
   *  are standard. */
  insuranceCoveragePct: numeric('insurance_coverage_pct', { precision: 5, scale: 2 }),
  // Typical 110% of CIF value per Incoterms convention

  inspectionRequirement: text('inspection_requirement'),
  // Values: 'sgs-loadport' | 'sgs-discharge' | 'sgs-both'
  //       | 'bv-loadport' | 'bv-discharge' | 'bv-both'
  //       | 'intertek-loadport' | 'caleb-brett-loadport'
  //       | 'cargo-inspection-by-buyer' | 'none'

  /** Quality standards referenced. Free text because grade specs
   *  vary widely (ASTM standards for refined products, ISO for some
   *  crude grades, GAFTA contract specs for grain). */
  qualityStandard: text('quality_standard'),

  // === Documentation ===

  /** Standard document set delivered by seller. Order matters —
   *  represents typical bank presentation sequence. */
  standardDocuments: text('standard_documents').array().notNull(),
  // Common values:
  //   'commercial-invoice', 'bill-of-lading' (3/3 originals),
  //   'certificate-of-origin', 'sgs-quality-certificate',
  //   'sgs-quantity-certificate', 'packing-list', 'beneficiary-cert',
  //   'phytosanitary-cert' (food), 'fumigation-cert' (grain),
  //   'cargo-manifest', 'mate-receipt', 'export-license',
  //   'insurance-policy', 'flag-state-certificate' (vessels)

  // === Timing ===

  /** Cycle time from inquiry to delivered/loaded cargo, in days. */
  typicalCycleTimeDaysMin: integer('typical_cycle_time_days_min'),
  typicalCycleTimeDaysMax: integer('typical_cycle_time_days_max'),

  laycanWindow: text('laycan_window'),
  // Values: 'narrow-3-day' | 'standard-5-day' | 'wide-7-day' | 'wide-10-day'

  // === Margin and commercial expectations ===

  marginStructure: text('margin_structure'),
  // Values: 'fixed-spread-per-unit' | 'pct-of-revenue'
  //       | 'cost-plus-pct' | 'floating-with-floor'
  //       | 'commission-only' | 'back-to-back-flat'

  /** Typical margin range when the structure is profitable.
   *  In percentage points (e.g. 1.5 for 1.5%) or USD/unit
   *  depending on marginStructure. */
  typicalMarginMin: numeric('typical_margin_min', { precision: 10, scale: 4 }),
  typicalMarginMax: numeric('typical_margin_max', { precision: 10, scale: 4 }),
  marginUnit: text('margin_unit'),
  // Values: 'pct' | 'usd-per-mt' | 'usd-per-bbl' | 'usd-per-shipment'

  // === Risk perimeter ===

  /** Whether OFAC pre-screening is required on every counterparty
   *  before the template can be used. */
  ofacScreeningRequired: boolean('ofac_screening_required').default(true),

  /** ISO-2 country codes excluded from this template's applicability.
   *  Hard exclusions independent of license framework. */
  excludedJurisdictions: text('excluded_jurisdictions').array().notNull(),
  // Default for VTC LLC: 'IR', 'KP', 'CU', 'SY' (per OFAC SDN comprehensive)
  // Vector Antilles has different perimeter — defined per template

  /** Specific counterparty types that disqualify use of this template
   *  even if the jurisdiction is permitted. */
  excludedCounterpartyTypes: text('excluded_counterparty_types').array().notNull(),
  // Common values:
  //   'sanctioned-state-owned' | 'designated-individual'
  //   | 'frozen-asset-subject' | 'pep-without-enhanced-dd'

  /** Whether this template can be used with origins that have OFAC
   *  General Licenses applicable. References license-specific notes. */
  generalLicenseEligible: text('general_license_eligible').array(),
  // e.g. ['VEN-GL-41-CHEVRON', 'RUS-GL-8-ENERGY']

  // === Counsel validation ===

  /** Whether outside counsel has reviewed this template's structural
   *  validity for the perimeter it covers. Per origination-partners-
   *  brief.md §4 — counsel-validated transaction templates are a
   *  core discipline rule, not a nice-to-have. */
  validatedByCounsel: boolean('validated_by_counsel').default(false),

  validatedAt: timestamp('validated_at'),
  validatedByFirm: text('validated_by_firm'),
  validationNotes: text('validation_notes'),

  // === Lifecycle ===

  status: text('status').notNull().default('draft'),
  // Values: 'active' | 'draft' | 'deprecated' | 'archived'

  notes: text('notes'),

  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}, (table) => ({
  slugIdx: uniqueIndex('deal_structure_templates_slug_idx').on(table.slug),
  categoryIdx: index('deal_structure_templates_category_idx').on(table.category),
  entityIdx: index('deal_structure_templates_entity_idx').on(table.vtcEntity),
  statusIdx: index('deal_structure_templates_status_idx').on(table.status),
}));
```

---

## 4. Commission structure schema

A new table `commission_structures`:

```typescript
export const commissionStructures = pgTable('commission_structures', {
  id: uuid('id').primaryKey().defaultRandom(),

  /** Stable kebab-case identifier. Examples:
   *    'origination-partner-50-50-net-profit'
   *    'intermediary-broker-half-pct-revenue'
   *    'specialty-crude-broker-bbl-fee'
   *    'vehicle-introducer-flat-1k'
   */
  slug: text('slug').notNull().unique(),

  /** Human-readable name. */
  name: text('name').notNull(),

  /** Type of party this commission applies to. */
  category: text('category').notNull(),
  // Values: 'origination-partner' | 'intermediary-broker'
  //       | 'sub-broker' | 'finder-fee' | 'introducer'
  //       | 'consultant' | 'sole-and-exclusive-broker'

  /** VTC's relationship to the fee. */
  partyRelationship: text('party_relationship').notNull(),
  // Values: 'vtc-pays-third-party' | 'vtc-receives-from-third-party'
  //       | 'split-with-third-party'

  /** Which VTC entity is party to this commission arrangement.
   *  Drives signature, ledger, currency. */
  vtcEntity: text('vtc_entity').notNull(),
  // Values: 'vtc-llc' | 'vector-antilles' | 'vector-auto-exports'
  //       | 'vector-food-fund'

  // === Fee mechanics ===

  basisType: text('basis_type').notNull(),
  // Values: 'pct-of-net-margin' | 'pct-of-gross-revenue'
  //       | 'usd-per-unit' | 'flat-fee-per-deal'
  //       | 'flat-fee-per-lifting' | 'tiered-by-volume'
  //       | 'tiered-by-margin' | 'success-fee-only'

  /** Polymorphic fee structure data. JSONB so it can capture
   *  the various basis types. Validation in TypeScript layer. */
  feeStructure: jsonb('fee_structure').notNull(),
  // Examples by basisType:
  //
  // pct-of-net-margin:
  //   { partyShare: 0.50 }
  //
  // pct-of-gross-revenue:
  //   { partyShare: 0.005 }  // half of 1%
  //
  // usd-per-unit:
  //   { amountUsd: 0.25, unit: 'bbl' }
  //
  // flat-fee-per-deal:
  //   { amountUsd: 50000 }
  //
  // tiered-by-volume:
  //   { tiers: [
  //       { minVolume: 0, maxVolume: 50000, ratePerUnit: 1.5, unit: 'mt' },
  //       { minVolume: 50000, maxVolume: 200000, ratePerUnit: 1.0, unit: 'mt' },
  //       { minVolume: 200000, maxVolume: null, ratePerUnit: 0.75, unit: 'mt' },
  //     ] }

  // === Triggering and timing ===

  triggerEvent: text('trigger_event').notNull(),
  // Values: 'on-contract-signature' | 'on-first-lifting'
  //       | 'on-each-lifting' | 'on-payment-received'
  //       | 'on-deal-completion' | 'pari-passu-with-margin'

  paymentTiming: text('payment_timing').notNull(),
  // Values: 'within-7-days' | 'within-14-days' | 'within-30-days'
  //       | 'within-60-days' | 'pari-passu-with-margin'
  //       | 'on-quarterly-cycle' | 'on-annual-true-up'

  // === Coverage ===

  /** Which deal categories this commission applies to. Empty array
   *  means applies to all categories. */
  appliesToCategories: text('applies_to_categories').array().notNull(),

  /** Which deal structure templates this commission applies to.
   *  Empty array means applies to all templates within the categories.
   *  Slugs reference deal_structure_templates.slug. */
  appliesToTemplateSlugs: text('applies_to_template_slugs').array().notNull(),

  /** Whether this commission can stack with other commissions on
   *  the same deal, or whether it's exclusive (only one applies).
   *  Critical for fee-burden analysis. */
  exclusivePerDeal: boolean('exclusive_per_deal').notNull().default(false),

  /** Whether this commission is exclusive to VTC for the term — i.e.
   *  the third party cannot offer the same opportunity to other
   *  principals during the agreement. */
  soleAndExclusive: boolean('sole_and_exclusive').notNull().default(false),

  // === Term and renewal ===

  /** Term length in months. NULL = ongoing / no fixed term. */
  termMonths: integer('term_months'),

  /** Whether the agreement auto-renews. */
  autoRenewal: boolean('auto_renewal').notNull().default(false),

  /** Notice period in days for termination. */
  terminationNoticeDays: integer('termination_notice_days'),

  // === Documentation ===

  /** Reference to a standard agreement clause template (e.g. file
   *  in /docs/legal-templates/) capturing the commission terms in
   *  contract language. */
  standardAgreementClause: text('standard_agreement_clause'),

  /** Whether VAT or sales tax applies to commission payments and
   *  in which jurisdictions. Free text because tax treatment varies. */
  taxTreatmentNotes: text('tax_treatment_notes'),

  notes: text('notes'),
  status: text('status').notNull().default('draft'),
  // Values: 'active' | 'draft' | 'deprecated' | 'archived'

  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}, (table) => ({
  slugIdx: uniqueIndex('commission_structures_slug_idx').on(table.slug),
  categoryIdx: index('commission_structures_category_idx').on(table.category),
  entityIdx: index('commission_structures_entity_idx').on(table.vtcEntity),
}));
```

---

## 5. Reference taxonomies (TypeScript)

A reference data file `packages/catalog/src/trade-taxonomy.ts` exporting the controlled vocabularies as TypeScript const arrays for type-safe schema validation:

```typescript
export const INCOTERMS_2020 = [
  'EXW', 'FCA', 'FAS', 'FOB',
  'CFR', 'CIF', 'CIP',
  'DAP', 'DPU', 'DDP',
  'DES',  // Deprecated in Incoterms 2020 but still used in crude trade
] as const;

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

export const CARGO_INSURANCE_CLAUSES = [
  'institute-cargo-clauses-a',
  'institute-cargo-clauses-b',
  'institute-cargo-clauses-c',
  'all-risks-marine',
  'war-risks-included',
  'buyer-arranged',
] as const;

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

export const VTC_ENTITIES = [
  'vtc-llc',
  'vector-antilles',
  'vector-auto-exports',
  'vector-food-fund',
  'stabroek-advisory',
] as const;

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
  'sds-msds',  // Safety data sheets for hazardous cargo
  'tank-experience-cert',  // For chemicals
  'load-port-survey',
  'discharge-port-survey',
] as const;

// ... and so on for the remaining vocabularies
```

These exports give TypeScript type safety on the JSONB metadata fields and on the assistant tool schemas.

---

## 6. Initial seed data — 25-40 deal structure templates

The catalog should be seeded with the structures VTC actually uses or is positioned to use. Below is a proposed seed list organized by category. You confirm or modify before population.

### 6.1 Refined product (VTC LLC)

| Slug | Region | Incoterm | Payment | Notes |
|---|---|---|---|---|
| `caribbean-refined-cif-lc-sight` | caribbean | CIF | lc-sight | Standard Caribbean diesel/gasoline cargo, Tier 2-3 buyers |
| `caribbean-refined-cif-lc-deferred-30` | caribbean | CIF | lc-deferred-30 | Tier 1 Caribbean refiners with payment relief |
| `caribbean-refined-cif-cad` | caribbean | CIF | cad | Smaller Caribbean distributors without LC infrastructure |
| `caribbean-refined-fob-tt-prepayment` | caribbean | FOB | tt-prepayment | Buyer-arranged freight, typical for distributor self-lift |
| `latam-refined-cfr-lc-sight` | latam-mainland | CFR | lc-sight | LatAm mainland (Colombia, Ecuador, Peru) refined product |
| `west-africa-refined-cif-lc-confirmed` | west-africa | CIF | lc-deferred-30 | West African refined product, confirmed LC standard |
| `us-gulf-refined-fob-pipeline` | us-gulf-coast | FOB | tt-against-docs | US Gulf Coast pipeline-FOB, USD domestic |

### 6.2 Specialty crude (Vector Antilles)

| Slug | Region | Incoterm | Payment | Notes |
|---|---|---|---|---|
| `specialty-crude-fob-origin-sblc` | mediterranean, middle-east-gulf | FOB | sblc-backed | Origin-loading specialty crude with SBLC performance guarantee |
| `specialty-crude-cif-destination-lc-deferred` | south-asia, east-asia, mediterranean | CIF | lc-deferred-60 | Delivered specialty crude to refining destinations |
| `specialty-crude-des-direct-discharge` | mediterranean, west-africa | DES | lc-deferred-30 | Direct ex-ship discharge, common for crude historically |
| `wa-crude-fob-cape-lopez` | west-africa | FOB | lc-deferred-30 | West African sweet crude FOB, Gabonese / Equatorial Guinean origin |
| `eastern-mediterranean-crude-cif-cypriot-discharge` | mediterranean | CIF | lc-deferred-60 | Eastern Mediterranean specialty crude into Cypriot or Turkish refining |

### 6.3 Crude conventional (VTC LLC, Vector Antilles when applicable)

| Slug | Region | Incoterm | Payment | Notes |
|---|---|---|---|---|
| `conventional-crude-fob-loadport` | global | FOB | lc-sight | Standard FOB crude, buyer-arranged freight |
| `conventional-crude-cif-tier-1-buyer` | global | CIF | lc-sight | Standard CIF crude, Tier 1 refiner buyer |
| `conventional-crude-cif-with-laytime` | global | CIF | lc-sight | CIF crude with explicit laytime provisions for discharge |

### 6.4 Food commodity (Vector Food Fund I)

| Slug | Region | Incoterm | Payment | Notes |
|---|---|---|---|---|
| `food-commodity-cif-lc-sight-gafta` | caribbean, latam-mainland | CIF | lc-sight | GAFTA-form contract, Caribbean / LatAm grain delivery |
| `food-commodity-cif-cad-smaller-buyers` | caribbean | CIF | cad | Smaller Caribbean food distributors, CAD payment |
| `food-commodity-fas-origin-tt-prepayment` | global | FAS | tt-prepayment | Buyer-arranged loading, prepayment for security |
| `food-commodity-cfr-narrow-laycan` | global | CFR | lc-sight | Time-sensitive food shipments with narrow laycan |

### 6.5 Vehicle export (Vector Auto Exports)

| Slug | Region | Incoterm | Payment | Notes |
|---|---|---|---|---|
| `vehicle-roro-cif-tt-prepayment` | caribbean | CIF | tt-prepayment | RoRo vehicle export, prepayment, CIF discharge |
| `vehicle-roro-fob-tt-against-docs` | global | FOB | tt-against-docs | Buyer-arranged shipping, TT on doc presentation |
| `vehicle-container-cif-escrow` | caribbean | CIF | escrow | Containerized vehicle export with escrow protection |

### 6.6 LNG / LPG (future-state, draft)

| Slug | Region | Incoterm | Payment | Notes |
|---|---|---|---|---|
| `lpg-cargo-cfr-lc-sight` | caribbean, west-africa | CFR | lc-sight | Refrigerated LPG cargo, future-state |

---

## 7. Initial seed data — 8-12 commission structures

| Slug | Category | Basis | VTC entity | Notes |
|---|---|---|---|---|
| `origination-partner-50-50-net-profit` | origination-partner | pct-of-net-margin | vtc-llc | Kenny Chavez / Kenge structure pattern |
| `origination-partner-60-40-net-profit-vtc-favored` | origination-partner | pct-of-net-margin | vtc-llc | Variant where VTC takes larger share for capital deployment |
| `intermediary-broker-half-pct-revenue` | intermediary-broker | pct-of-gross-revenue | vtc-llc | Standard intermediary broker on closed cargo |
| `intermediary-broker-quarter-pct-revenue` | intermediary-broker | pct-of-gross-revenue | vtc-llc | Reduced rate for high-volume relationships |
| `specialty-crude-broker-bbl-fee` | sub-broker | usd-per-unit | vector-antilles | $0.10-$0.50/bbl on closed specialty crude cargoes |
| `caribbean-fuel-flat-per-cargo` | sub-broker | flat-fee-per-deal | vtc-llc | $10K-$50K per Caribbean refined cargo |
| `vehicle-introducer-flat-1k` | introducer | flat-fee-per-deal | vector-auto-exports | Flat fee per introduced vehicle buyer |
| `food-commodity-success-fee-pct-margin` | finder-fee | pct-of-net-margin | vector-food-fund | Success fee on first deal only with new food buyer |
| `consultant-monthly-retainer-plus-bonus` | consultant | hybrid | vtc-llc | Monthly retainer + per-deal bonus structure |

The structure of the catalog allows additions as new commission arrangements are negotiated. Each new partner agreement creates either a reference to an existing commission structure or a new entry if the terms are novel.

---

## 8. Assistant tools

Two new chat tools that make the catalogs queryable from procur's assistant interface and from vex via the existing intelligence HTTP API:

```typescript
/**
 * Find deal structure templates matching specified criteria.
 * Returns templates ranked by best fit to the inputs.
 *
 * Use when composing proposals, drafting outreach that references
 * structure, or analyzing which templates apply to a specific
 * opportunity.
 */
lookup_deal_structure_template(args: {
  category?: 'refined-product' | 'specialty-crude' | 'crude-conventional'
           | 'food-commodity' | 'vehicle' | 'lng' | 'lpg';
  region?: string;  // From REGIONS taxonomy
  vtcEntity?: 'vtc-llc' | 'vector-antilles' | 'vector-auto-exports'
            | 'vector-food-fund' | 'stabroek-advisory';
  preferredIncoterm?: string;  // From INCOTERMS_2020
  preferredPaymentInstrument?: string;  // From PAYMENT_INSTRUMENTS
  destinationCountry?: string;  // ISO-2 — used to filter excluded jurisdictions
  status?: 'active' | 'draft' | 'all';  // default 'active'
}) => DealStructureTemplate[]

/**
 * Find commission structures that apply to a specified deal context.
 * Returns commissions that would be triggered by a deal of the given
 * shape, useful for computing total fee burden on a proposed deal.
 *
 * Use when modeling deal economics, drafting partner agreements, or
 * computing margin after all applicable third-party fees.
 */
lookup_commission_structures(args: {
  dealCategory?: string;
  dealTemplateSlug?: string;  // If provided, returns only commissions
                              // applicable to this specific template
  vtcEntity?: string;
  partyRelationship?: 'vtc-pays-third-party'
                    | 'vtc-receives-from-third-party'
                    | 'split-with-third-party';
  status?: 'active' | 'draft' | 'all';
}) => CommissionStructure[]
```

Both tools return structured results with the catalog entries' full metadata, so the assistant can compose with precise reference to the actual VTC structure rather than pattern-matching from training data.

---

## 9. System prompt additions for trade vocabulary

A new section in the assistant system prompt — generic industry vocabulary that grounds the assistant's compositional language without requiring database lookups for every reference.

The section is reproduced in full below for the implementer to add verbatim to the system prompt:

```markdown
## Trade structure vocabulary

When composing outreach or analyzing deals, use the precise vocabulary
of physical commodity trading. Imprecise vocabulary signals to
counterparties that the writer is not operationally fluent.

### Incoterms 2020

The relevant Incoterms for VTC's deal universe:

- **EXW (Ex Works)** — buyer takes title and risk at seller's
  facility. Buyer arranges all transport, export clearance,
  insurance. Lowest seller commitment.
- **FCA (Free Carrier)** — seller delivers cleared goods to a
  named carrier or place. Risk transfers when carrier takes
  possession.
- **FAS (Free Alongside Ship)** — seller delivers goods alongside
  the named vessel at the loadport. Used in commodity bulk trade.
- **FOB (Free On Board)** — seller delivers goods on board the
  vessel at the loadport. Risk transfers when goods cross the
  ship's rail (Incoterms 2020 says "on board"). Standard for crude
  and refined product loaded directly to vessel.
- **CFR (Cost and Freight)** — seller pays freight to discharge
  port; risk transfers at loadport. Buyer arranges insurance.
- **CIF (Cost, Insurance, Freight)** — seller pays freight and
  cargo insurance to discharge port; risk transfers at loadport.
  Standard for delivered cargoes where seller wraps the
  insurance arrangement.
- **CIP (Carriage and Insurance Paid To)** — like CIF but for
  any mode of transport, not just sea.
- **DAP (Delivered at Place)** — seller delivers at named place
  at destination, ready for unloading.
- **DPU (Delivered at Place Unloaded)** — seller delivers and
  unloads at destination.
- **DDP (Delivered Duty Paid)** — seller delivers at destination
  with duties cleared. Highest seller commitment.
- **DES (Delivered Ex-Ship)** — technically deprecated in
  Incoterms 2020 but still used in crude trade for direct ex-ship
  discharge structures.

### Payment instruments

- **LC sight** — letter of credit payable on presentation of
  conforming documents. Highest seller protection short of
  prepayment.
- **LC deferred (30/60/90/180)** — payable at specified period
  after document presentation. Common in crude trade for buyer
  cash management.
- **CAD (Cash Against Documents)** — no LC. Documents released
  to buyer against payment via the buyer's bank. Lower seller
  protection than LC; faster.
- **TT prepayment** — telegraphic transfer before shipment.
  Strongest seller protection; weakest buyer protection.
- **TT against docs** — wire transfer on document presentation,
  similar mechanics to CAD without bank intermediation as deeply.
- **SBLC-backed** — standby letter of credit functions as a
  performance guarantee, not a payment instrument. Common in
  crude trade where the SBLC backs payment obligation while the
  underlying mechanics may be open-account.
- **Open account** — no instrument. Payment on agreed terms.
  Highest counterparty risk.
- **Escrow** — funds held by neutral third party, released on
  agreed conditions. Common in vehicle trade and small-cargo
  transactions.
- **Documentary collection** — documents handled by banks but
  without LC undertaking. Mid-tier protection.

### Insurance and inspection

- **Institute Cargo Clauses A** — broadest cover; "all risks"
  except specific exclusions. Standard for high-value cargo.
- **Institute Cargo Clauses B** — more limited cover, named
  perils only.
- **Institute Cargo Clauses C** — most limited; major casualty
  cover only. Common for bulk commodities where the loss
  scenario is total-loss-of-vessel.
- **All risks marine** — generic phrase often referring to
  Cargo Clauses A.
- **War risks included** — additional cover for war, strikes,
  riots. Often required separately for high-risk routes.

- **SGS** — Société Générale de Surveillance, dominant
  inspection company globally for petroleum and grain.
- **Bureau Veritas (BV)** — second-largest inspection firm.
- **Intertek** — common for refined product inspection.
- **Caleb Brett** — Intertek's petroleum inspection brand.

### Commercial concepts

- **Laycan** — laydays/cancelling, the window during which the
  vessel must arrive at loadport for loading. Narrow laycan
  (3-day) signals tight scheduling; wide laycan (10-day) gives
  buyer flexibility.
- **Demurrage** — penalty paid by the party causing delay
  beyond agreed laytime at port.
- **Despatch** — bonus paid for completing loading/discharge
  faster than agreed laytime. Functionally the inverse of demurrage.
- **Back-to-back** — VTC simultaneously buys and sells the same
  cargo with matching terms, taking margin between the two
  contracts without taking physical position.
- **Carry** — in commission context, the percentage of net
  profit taken by an originating partner or carry-eligible
  party. "50/50 carry" means equal split of net profit.
- **Sole and exclusive** — in broker context, the relationship
  precludes the broker from offering the same opportunity to
  other principals during the agreement term.

When the operator references VTC's specific deal structures, look
them up through the lookup_deal_structure_template tool rather than
inferring from this generic vocabulary. The tools return VTC's
actual standards; the vocabulary above grounds the assistant's
language so the lookups land in the right context.
```

---

## 10. Integration with existing tables

The two new catalogs integrate with three existing schema layers:

### 10.1 `proposals`

Add columns:

```sql
ALTER TABLE proposals
  ADD COLUMN deal_structure_template_slug text
    REFERENCES deal_structure_templates(slug),
  ADD COLUMN applicable_commission_slugs text[] DEFAULT '{}';
```

When a proposal is generated using `lookup_deal_structure_template`, the slug is recorded. Free-text override fields remain in place for deal-specific deviations from the standard template.

### 10.2 `pricing_models`

Add column:

```sql
ALTER TABLE pricing_models
  ADD COLUMN deal_structure_template_slug text
    REFERENCES deal_structure_templates(slug);
```

Pricing models can be authored against templates, inheriting the margin structure parameters from the template and overriding only what's deal-specific.

### 10.3 `contracts`

Add columns:

```sql
ALTER TABLE contracts
  ADD COLUMN deal_structure_template_slug text
    REFERENCES deal_structure_templates(slug),
  ADD COLUMN applied_commission_slugs text[] DEFAULT '{}';
```

Executed contracts record which template they instantiated and which commissions applied. This is the data layer that enables analytics on which structures close, at what rate, with what margin profile.

### 10.4 Backfill for existing records

Existing proposals and contracts have no template slug. Recommended approach:

- Leave existing records with NULL slug
- Forward-only: only new proposals and contracts use the catalog
- Optional: a manual backfill pass on the most recent 10-20 contracts to validate the catalog covers VTC's actual practice

A migration that automatically backfills existing records would require pattern-matching their free-text terms against template definitions, which is error-prone. Better to validate forward.

---

## 11. Operational sequencing

Recommended order of execution:

**Day 1** — Schema and reference data
- Migrations creating both tables and the additions to proposals / pricing_models / contracts
- TypeScript reference taxonomies
- Validation (every enum value used in seed data exists in the taxonomy)

**Day 2** — Seed data population
- Hand-curate the 25-40 deal structure templates from §6
- Hand-curate the 8-12 commission structures from §7
- Validation pass: every commission structure references either real categories or real template slugs

**Day 3** — Assistant tools and UI
- Two chat tools (`lookup_deal_structure_template`, `lookup_commission_structures`)
- Catalog browse pages in procur UI (read-only initially; admin-edit deferred to v2)
- System prompt addition with the trade vocabulary section from §9

**Day 4** — Integration
- Update proposal-generation flow to record `deal_structure_template_slug` when a template is referenced
- Update contract-creation flow to record applicable commission slugs
- Pricing model authoring inherits from templates

**Day 5** — Validation and documentation
- End-to-end test: compose a Caribbean diesel proposal using `lookup_deal_structure_template`, verify it references the correct template, verify the structured data flows through to the proposal record
- Same for a specialty crude proposal under Vector Antilles
- Update operator-facing documentation explaining the catalog

Total: 3-5 days of focused build effort.

---

## 12. What this enables strategically

Beyond the immediate operational improvements, the catalog enables several capabilities that compound over time:

**Structure analytics.** Once 6+ months of contracts reference templates, you can answer questions like: "What's our close rate on specialty crude FOB-origin SBLC vs CIF-destination LC?" "Which Caribbean refined structures produce the highest realized margin?" "Are 50/50 origination partner deals more likely to close than 60/40?" These questions are unanswerable today. They become first-class analytics with the catalog in place.

**Counsel review at scale.** The `validatedByCounsel` field captures which structures have been counsel-reviewed. As Vector Antilles' specialty crude work expands, every new origin × destination × payment-instrument permutation needs counsel review. The catalog tracks which permutations are validated and which require fresh review. Counsel time is expensive; reusing validated structures across deals materially reduces deal-specific legal cost.

**Faster proposal generation.** Composing a proposal from a template takes minutes; composing from scratch takes an hour. The 60-minute saving compounds across every proposal VTC generates over the next several years.

**Onboarding leverage for origination partners.** When a new partner asks "what structures does VTC typically work with?", the answer is a queryable list rather than a verbal walkthrough. Partners can self-serve to understand which structures fit their deal flow before introducing opportunities.

**Cross-pollination across categories.** A specialty crude template's payment-instrument approach can inform a refined product template's risk perimeter. Patterns that work in one category often have analogs in others; the catalog makes those patterns visible rather than implicit.

---

## 13. Why this category specifically — and why now

A reasonable question is whether deal structures and commissions are the right next addition versus other operational layers. The case:

**It's the smallest brief with the highest immediate operational return.** Three to five days of build effort. Every proposal composed thereafter benefits. Every contract analyzed thereafter is queryable. The ROI per day of build effort is dramatically higher than most alternatives.

**It addresses a real friction every time you compose outreach.** Without the catalog, the assistant pattern-matches deal terms from training data, producing outreach that's *almost* right but operationally imprecise. With the catalog, the assistant references VTC's actual standards. The quality difference is visible to recipients.

**It's a prerequisite for several future capabilities.** Pricing analytics on structure-by-structure margin requires structured deal templates. Origination partner fee accruals require structured commission records. Counsel-validated transaction tracking requires structured templates. Multiple downstream capabilities compound on this foundation.

**The work itself is bounded and unambiguous.** Schema, seed data, two tools, three table integrations, system prompt addition. Not an ingestion project; not a research project. Hand-curation against a clear schema. Low execution risk.

Compared to other near-term additions:

| Addition | Effort | Operational ROI | Strategic ROI |
|---|---|---|---|
| **Deal & commission catalog** | 3-5 days | High immediate | High compounding |
| Environmental services rolodex | 3-4 weeks | Moderate | High in adjacent capability scenarios |
| Buyer intelligence v1.5 | 2 weeks | Moderate | High in proactive matching |
| Trinidad/Guyana scrapers | 1 week each | Low immediate | Moderate longer-term |
| Origination partner workflow extension | 2-3 weeks | Low until partners ship deals | Moderate when partners materialize |

The deal & commission catalog is the highest-leverage near-term work. **Build this next, before extending environmental services or other ingestion-heavy categories.**

---

## 14. Success metrics

How to know if this work was worth doing, three months after deployment:

- **Adoption**: ≥80% of new proposals reference a `deal_structure_template_slug`
- **Coverage**: catalog has 25-40 templates, all in `active` status, all with notes
- **Counsel validation**: ≥10 templates marked `validatedByCounsel = true`
- **Operational use**: chat tools called ≥30 times in real conversations over the three-month window
- **Analytics capability**: at least one analytics query (close rate by structure, margin by structure, fee burden by commission stack) is being run regularly

If these metrics are met, the catalog is delivering. If they aren't, either the catalog has gaps the operator's actual practice exposed (which is information — refine the templates) or the integration with proposal-generation isn't being used (which is also information — surface the catalog more prominently in the proposal flow).

---

## 15. What this brief deliberately doesn't include

- **No generic Incoterms reference data in the database.** Static industry vocabulary belongs in the system prompt and reference taxonomies, not the database.
- **No AI-generated template authoring.** Templates are authored by the operator with assistant assistance. The system doesn't auto-generate plausible templates because that defeats the purpose — the catalog only has value if it captures real practice.
- **No automated counsel review.** The `validatedByCounsel` field is set manually after counsel review; the system doesn't auto-validate based on similarity to other validated templates. Counsel review is a human judgment call.
- **No commission-stack auto-computation in this brief.** The catalog enables fee-burden analysis but the actual computation across multiple applicable commissions on a single deal is a separate analytics workstream — useful, deferred to v2.
- **No customer-facing exposure of the catalog.** The catalog is internal operational reference. Partners and counterparties see proposals composed from templates; they don't see the templates themselves. Avoiding leakage of VTC's standard terms to counterparties is intentional.

---

End of deal structure and commission catalog brief.
