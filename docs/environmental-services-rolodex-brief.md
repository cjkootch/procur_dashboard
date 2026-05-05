# Environmental Services Rolodex — A New Category in Procur

**Status:** spec, not yet implemented
**Owner:** Cole
**Last updated:** 2026-05-04
**Repo:** `cjkootch/procur_dashboard`
**Companion to:** `docs/strategic-vision.md` (procur as the entity rolodex), `docs/intelligence-layers-brief.md` (the ingestion pattern this brief follows), `docs/data-graph-connections-brief.md` (the connections this category will participate in once populated)

This brief specifies a new entity category in procur — environmental services operators with verified regulatory licensing across Latin America and North America — and the ingestion plan that populates it from public regulator registries. Total estimated effort: ~3-4 weeks across three phases. The category becomes a queryable layer in procur with the same enrichment depth (ownership graph, news events, capability metadata) as the refinery and trader rolodexes.

The strategic case for this work is in §1. The implementation plan is in §3-§7. If you're new to this brief, read §1 and §10 to understand why; read §3-§7 for what.

---

## 1. Why this brief exists

VTC's procur rolodex currently models the upstream and midstream commodity universe — refineries, trading houses, producer marketing arms, fuel distributors. **It does not model the adjacent capability universe** — companies that supply technical services around the same operator base. Environmental services is the most operationally relevant of these adjacencies, for four reasons:

**(a)** It touches the same operator universe procur already models. A Pemex refinery has both a crude procurement function (already in procur) and a waste-handling function (not yet in procur). The same SEMARNAT-licensed operator may serve five different Pemex facilities across Mexico, several Colombian operators in Casanare, and emerging Caribbean utility decommissioning projects. **Adjacency to the existing rolodex is the structural fit.**

**(b)** The data is publicly available but operationally hard to access. Regulator registries across Latin America publish authorized-handler lists for hazardous waste, oilfield waste, and environmental remediation. The data is in Spanish and Portuguese, often in PDF format, distributed across 30+ regulatory authorities. Aggregating it is non-trivial. **That aggregation difficulty is exactly what creates the moat for whoever does the work.**

**(c)** The category sits at the intersection of multiple workstreams VTC is already pursuing. Specialty crude conversations occasionally touch on refinery decommissioning. Caribbean fuel work occasionally touches utility plant waste handling. The bilateral counterparties research universe overlaps with environmental remediation suppliers in several Latin American producing countries. **The adjacent capability is touched, not central, in many existing conversations.** Having it pre-mapped converts ad-hoc research into instant lookup.

**(d)** It is durable infrastructure independent of any specific commercial opportunity. The brief that prompted this work was a Venezuelan oilfield waste opportunity that may or may not be commercially viable. The rolodex enrichment is valuable regardless of whether that specific opportunity proceeds — it positions VTC for any environmental services question that arises in the producing-country and refining-country universe over the next several years. **Build the universe before any single deal needs it.**

The implementation cost is moderate. The ROI compounds across many opportunities rather than one.

---

## 2. What this brief deliberately doesn't include

A few clarifications about scope to prevent feature creep:

- **No Venezuela-specific scoring or willingness flags in the schema.** Venezuela engagement is a per-deal-context attribute that depends on current OFAC framework, counsel review, and specific deal facts. Storing "Venezuela willingness" in the rolodex creates stale data; the schema instead captures *factual* attributes (Latin American countries served, regulator licenses held, technologies available) and lets per-deal context determine willingness at the moment a deal materializes.
- **No new commercial actions tied to this rolodex.** The category is reference material. Outreach to environmental services operators happens through vex's existing campaign infrastructure, and any specific outreach about a specific opportunity goes through the existing supplier-approval workflow. This brief builds the universe; it doesn't change how engagement happens.
- **No equipment-only providers as primary entries.** Equipment manufacturers (centrifuges, dryers, thermal desorption units) are downstream of service providers. The rolodex models *operators* who can be engaged for projects; equipment makers are captured as metadata when relevant ("uses TWMA RotoMill technology") but are not first-class entities. This avoids polluting the rolodex with thousands of low-relevance equipment SKUs.
- **No commercial contact databases as primary sources.** Apollo, RocketReach, and ZoomInfo are useful for contact enrichment in Phase 3, but they are not the structural foundation. The structural foundation is regulator-verified licensure, which is what makes the rolodex more credible than a generic B2B contact list.

---

## 3. The category schema

A new value for `known_entities.role`:

```typescript
type EntityRole =
  | 'refiner'
  | 'trader'
  | 'producer'
  | 'fuel-distributor'
  | 'utility'
  // ... existing roles
  | 'environmental-services';  // NEW
```

Plus a new metadata structure for environmental services entities:

```typescript
interface EnvironmentalServicesCapability {
  /** What waste streams the operator is licensed and equipped to handle.
   *  Drawn from the operational universe of upstream/downstream petroleum
   *  waste; not all-encompassing of every hazardous waste type. */
  wasteTypesHandled: Array<
    | 'drilling-mud-water-based'
    | 'drilling-mud-oil-based'
    | 'drilling-mud-synthetic-based'
    | 'drill-cuttings'
    | 'oily-sludge'
    | 'tank-bottoms'
    | 'pit-waste'
    | 'produced-water-sludge'
    | 'refinery-sludge'
    | 'contaminated-soil'
    | 'hydrocarbon-contaminated-water'
    | 'spent-catalysts'
    | 'naturally-occurring-radioactive-material' // NORM
    | 'crude-spill-residue'
  >;

  /** Treatment technologies the operator deploys. Multi-select. */
  treatmentTechnologies: Array<
    | 'thermal-desorption'
    | 'bioremediation'
    | 'solidification-stabilization'
    | 'chemical-treatment'
    | 'centrifugation'
    | 'cuttings-dryer'
    | 'shale-shaker-recycling'
    | 'oil-water-separation'
    | 'incineration'
    | 'co-processing-cement-kiln'
    | 'landfarming'
    | 'encapsulation'
    | 'distillation-recovery'
  >;

  /** Whether the operator can deploy mobile units to the project site
   *  rather than requiring waste transport to a fixed facility.
   *  Mobile-capable operators significantly expand the geographic
   *  feasibility window for any given project. */
  mobileCapability: boolean;

  /** Whether the operator runs (or partners with) certified labs for
   *  waste characterization and environmental classification. */
  labCapability: boolean;

  /** Countries where the operator has documented operational presence.
   *  ISO-2 country codes. Distinct from regulator licenses — an operator
   *  may have presence without licensure or vice versa. */
  countriesServed: string[];

  /** Regulator licenses held. Each entry captures the issuing authority,
   *  license category, license number where public, and validity status.
   *  This is the verifiable-licensure layer that distinguishes rolodex
   *  entries from generic vendor directories. */
  regulatorLicenses: Array<{
    authority: string;        // e.g. 'SEMARNAT', 'IBAMA', 'ANLA', 'CAR-Cundinamarca', 'EPA'
    country: string;          // ISO-2
    licenseCategory: string;  // e.g. 'Rubro 5 - Tratamiento', 'CTF/APP', 'NAICS-562211'
    licenseNumber: string | null;
    validUntil: string | null;  // ISO date
    sourceUrl: string;
  }>;

  /** Named oil and gas operators the company has publicly disclosed
   *  as prior clients. Useful for credibility assessment. Drawn from
   *  case studies, ESG reports, regulator filings. */
  priorOilGasClients: string[];

  /** Free-text notes on capability nuances — proprietary technologies,
   *  geographic strengths, recent project examples. */
  notes: string;

  /** 0.0-1.0 confidence in the rolodex entry's accuracy. Higher
   *  for entries verified through multiple sources (regulator
   *  registry + company website + named client disclosure); lower
   *  for entries from single sources. */
  confidenceScore: number;
}
```

The metadata sits at `known_entities.metadata.environmentalServices`. No migration required — `metadata` is already `jsonb`.

---

## 4. Phase 1 — Clean structured sources (4-5 days)

Phase 1 ingests from the four sources with the cleanest data extraction paths. By the end of Phase 1, the rolodex contains roughly 800-1,500 entities with verified regulator licensing. This is the foundation.

### 4.1 EPA RCRA Info (United States)

The federal hazardous waste tracking database, public, queryable by NAICS code. The relevant NAICS codes for the petroleum waste universe:

- **562211** — Hazardous Waste Treatment & Disposal
- **562910** — Environmental Remediation Services
- **562998** — All Other Miscellaneous Waste Management
- **213112** — Support Activities for Oil and Gas Operations (cross-filter)

Approach: bulk download the RCRA Info dataset (CSV available at data.gov), filter to handlers active in the last 24 months across the four NAICS codes above, intersect with petroleum-related waste codes (RCRA codes F-series, K-series specific to petroleum refining wastes). Result: the verified universe of US hazardous waste operators with petroleum sector exposure.

Geographic coverage: Texas, Louisiana, Oklahoma, California are the heaviest concentrations and the most operationally relevant for VTC's Caribbean / LatAm work (proximity for mobile deployment, US Gulf Coast operator base).

Estimated entity count: ~400-600 after filtering.

### 4.2 IBAMA CTF Brazil

Brazil's federal environmental agency maintains the Cadastro Técnico Federal (CTF), which registers all entities engaged in potentially polluting activities or that use environmental resources. Two registry types relevant here:

- **CTF/APP** — Atividades Potencialmente Poluidoras (potentially polluting activities), which includes waste transport, treatment, oilfield services
- **CTF/AIDA** — Atividades e Instrumentos de Defesa Ambiental (environmental defense activities), which includes waste-management consulting and lab services

The public consulta is at gov.br/ibama with CNPJ lookup. There's no bulk-export API, but the consulta is queryable programmatically.

Approach: seed list of Brazilian environmental services CNPJs from publicly-available industry directories (Abetre member list, ABREPETRO oilfield services directory). For each CNPJ, query CTF consulta to verify registration status and pull registered activity codes. Categories that matter for petroleum waste:

- "Tratamento de resíduos" (waste treatment)
- "Petróleo e Gás" (petroleum and gas activities)
- "Transporte de cargas perigosas" (dangerous cargo transport)
- "Recuperação de áreas contaminadas" (contaminated area recovery)

Result: verified list of CTF-current Brazilian environmental services operators with category breakdowns.

Estimated entity count: ~150-300.

### 4.3 ANLA Colombia open-data portal

Colombia's federal environmental licensing authority publishes structured datasets at datos.anla.gov.co, including federally-licensed operators across multiple sectors. The relevant sectors:

- **Hidrocarburos** (oil and gas) — licensed under Decreto 1076 de 2015
- **Residuos peligrosos** (hazardous waste)
- **Remediación ambiental** (environmental remediation)

Approach: ingest the structured datasets directly via the open-data API. ANLA publishes resolutions granting environmental licenses; these resolutions include the licensed entity, the activity scope, the geographic area, and validity dates. Parse the resolution metadata to construct rolodex entries.

Estimated entity count: ~100-200 federally-licensed.

### 4.4 Energy Dais commercial directory (cross-reference)

The largest oil and gas company directory globally, with category structure including waste management, environmental services, and equipment providers. Entries are not regulator-verified but provide:

- Operating contact information not present in regulator registries
- Cross-validation of operator presence (a company in Energy Dais but not in any regulator registry warrants investigation)
- Equipment provider information for the metadata layer (without making them first-class entities)

Approach: web scrape (rate-limited, respectful) for the waste management category and cross-filter to companies operating in Latin America or US Gulf Coast. Use as an enrichment layer over the regulator-verified core.

Estimated entity additions: ~100-200 entities not surfaced by regulator data alone.

### 4.5 Phase 1 deliverables

- Migration `0061_environmental_services_role.sql` — adds `'environmental-services'` to the `EntityRole` enum if it's enforced at DB level (otherwise text validation only)
- Ingestion job `packages/ingestion/src/environmental-services/` — orchestrates the four sources above, writes to `known_entities` with the metadata structure from §3
- Reference data file `packages/catalog/src/environmental-services-taxonomy.ts` — exports the waste type and treatment technology vocabularies as TypeScript const arrays for type-safe metadata
- Initial rolodex population of approximately 800-1,500 entities

---

## 5. Phase 2 — Latin American regulator registries (2-3 weeks)

Phase 2 is the work that creates the moat. The Latin American regulator registries are PDF-heavy, distributed across many authorities, and require Spanish/Portuguese parsing. **This is the work that almost no commercial database does systematically, which is why Phase 2 is where VTC's environmental services rolodex becomes structurally differentiated.**

### 5.1 Mexico — SEMARNAT

The Secretaría de Medio Ambiente y Recursos Naturales publishes a downloadable list of authorized hazardous waste companies divided into 15 rubros (categories). The list shows company names, authorization numbers, validity dates, and operating states. Hosted at gob.mx/semarnat.

The 15 rubros and which matter for petroleum waste:

| Rubro | Category | Petroleum waste relevance |
|---|---|---|
| 1 | Reciclaje (recycling) | Yes — solvent and oil recycling |
| 2 | Aprovechamiento (utilization) | Yes — fuel-from-waste, co-processing |
| 3 | Co-procesamiento (co-processing) | Yes — cement kiln co-processing of hydrocarbon waste |
| 4 | Reutilización (reuse) | Marginal |
| 5 | **Tratamiento (treatment)** | **Primary — thermal, chemical, biological treatment of hazardous waste** |
| 6 | **Incineración (incineration)** | **Primary — destruction of hydrocarbon waste** |
| 7 | Confinamiento (confinement / landfill) | Yes — final disposal of treated residues |
| 8 | Transporte (transport) | Yes — specialized transport of hazardous waste |
| 9 | Almacenamiento (storage) | Yes — temporary storage during treatment cycles |
| 10-15 | Specialty / biological / radioactive | Limited petroleum relevance |

Approach: download the published PDFs (one per rubro), OCR-and-parse, extract company names, authorization numbers, states. Cross-reference with INEGI's official business registry (RFC validation) where possible to standardize entity names. Deduplicate across rubros — many operators are licensed in multiple categories and should appear as single entities with multi-rubro licensure.

Estimated entity count: ~300-500 unique operators across petroleum-relevant rubros.

### 5.2 Colombia — Regional CARs

Colombia's environmental licensing is split between ANLA (federal, large projects) and 33 Corporaciones Autónomas Regionales (CARs) for regional licensing of waste handlers. Not all CARs publish their authorized-handler lists, but the major oil-producing region CARs do. Priority order:

1. **CAR Cundinamarca** — covers Bogotá metro and surrounding region; many oilfield services HQ there. Publishes downloadable PDF of authorized hazardous waste managers.
2. **Cormacarena** (Meta) — heart of Colombian oil production; eastern plains.
3. **Corporinoquia** (Casanare, Arauca) — major oil-producing departments.
4. **CDMB** (Santander) — Barrancabermeja refinery region.
5. **Corantioquia** (Antioquia) — Medellín region, industrial waste.

Approach: download each CAR's published authorized-handler list (formats vary — some PDF, some HTML, some delivered as resolutions issued one-per-operator). Parse the structured fields (operator name, license number, authorized waste types, treatment methods, validity dates). Each CAR is its own scraping task with its own structure.

Estimated entity count: ~150-300 across the five priority CARs.

### 5.3 Argentina — Provincial environmental authorities

Argentina's environmental enforcement is provincial. The relevant provinces for oil/gas waste:

- **Neuquén** — Vaca Muerta operations
- **Mendoza** — older conventional production
- **Chubut** — Patagonia upstream
- **Santa Cruz** — Patagonia upstream
- **Buenos Aires** — refining and downstream

Each provincial Secretaría de Ambiente publishes its own list of licensed waste handlers, with varying public accessibility. No single national registry.

Approach: per-province scraping, prioritized by oil sector activity. Manual fallback for provinces with no public list (entities sourced from industry directories, license verification deferred).

Estimated entity count: ~100-150.

### 5.4 Other Latin America (lower priority)

- **Peru — OEFA** (Organismo de Evaluación y Fiscalización Ambiental) — environmental enforcement registry
- **Ecuador — MAATE** (Ministerio del Ambiente) — environmental authorizations
- **Trinidad — EMA** (Environmental Management Authority) — waste handler permits, narrower universe but operationally relevant for Caribbean work
- **Guyana — EPA** (Environmental Protection Agency) — emerging registry as oil sector develops

These have lower density of relevant operators. Ingest opportunistically as Phase 2 progresses; not blocking.

### 5.5 Phase 2 deliverables

- Per-source scraping jobs in `packages/ingestion/src/environmental-services/regulators/`
- OCR pipeline for PDF-only sources using Tesseract or commercial OCR API for higher accuracy on Spanish-language documents
- Entity deduplication logic — many operators appear in multiple regulator registries (e.g. a Mexican operator licensed in both SEMARNAT Rubro 5 and Rubro 8); the deduplication merges these into single entities with the full license profile
- Periodic refresh schedule — quarterly for SEMARNAT and CAR PDFs (regulator publication cadence), monthly for ANLA and IBAMA (more responsive sources)

---

## 6. Phase 3 — Contact enrichment (1 week)

Phase 3 layers contact-level data onto the regulator-verified entity universe from Phases 1-2. This is what makes the rolodex actually contactable rather than just structurally sound.

### 6.1 Approach

For each entity in the environmental services category, query a commercial contact database (Apollo, Cognism, or RocketReach) for:

- Decision-maker contacts at the company (CEO, COO, business development, environmental services director)
- Verified email addresses and phone numbers where available
- LinkedIn profile URLs for credibility verification

Write the contact data to the existing `entity_contact_enrichments` table (already populated for refineries and traders by vex's contact-enrichment workflow).

### 6.2 Tier prioritization

Not all 1,500-2,500 entities warrant contact-level enrichment. Prioritize:

- **Tier 1**: top 50 by combination of (regulator licensure breadth, prior oil/gas client count, geographic coverage). These are the operators most likely to surface as candidate partners for adjacent capability conversations.
- **Tier 2**: next 150 by similar criteria. Enrich opportunistically.
- **Tier 3**: remaining entities. Contact data added only when a specific opportunity makes them relevant.

Apollo's pricing model favors batched lookups; ~$500-1,000 of API cost gets you Tier 1 + Tier 2 enrichment.

### 6.3 Phase 3 deliverables

- Enrichment job in `packages/ingestion/src/environmental-services/contact-enrichment.ts`
- Tier scoring view that ranks environmental services entities for enrichment priority
- ~200 fully contactable entities by end of Phase 3

---

## 7. Assistant tools

Two new chat tools that make the rolodex actually queryable from vex's chat surface and from procur's assistant interface:

```typescript
/**
 * Find environmental services operators capable of handling a specific
 * waste type, optionally filtered by country or regulator authority.
 *
 * Use when an opportunity surfaces that requires waste-handling capability
 * — refinery turnaround, decommissioning project, oilfield waste cleanup,
 * or any conversation that touches environmental remediation.
 */
find_environmental_operators_for_waste_type(args: {
  wasteType: string;       // From wasteTypesHandled enum
  inCountries?: string[];  // ISO-2 codes
  withLicenseFrom?: string;  // e.g. 'SEMARNAT', 'IBAMA'
  mobileCapabilityRequired?: boolean;
}) => EnvironmentalOperatorMatch[]

/**
 * Find environmental services operators with operational presence in
 * a specific country, optionally filtered by capability.
 *
 * Use when assessing capability density in a market — "what's the
 * universe of authorized operators in Casanare for hydrocarbon-
 * contaminated soil remediation?"
 */
find_environmental_operators_for_country(args: {
  country: string;  // ISO-2
  capabilityFilter?: {
    wasteTypes?: string[];
    treatmentTechnologies?: string[];
    requireLabCapability?: boolean;
    requireMobileCapability?: boolean;
  };
  minConfidenceScore?: number;  // default 0.6
}) => EnvironmentalOperatorMatch[]
```

Both tools return structured results with the regulator licenses explicit — the operator can see *why* a candidate matches (which authority licenses them, which categories) rather than just receiving a name list.

---

## 8. Integration with existing procur capabilities

The environmental services category participates in the data graph connections from `docs/data-graph-connections-brief.md`:

- **Ownership graph (work item 2)** — when "Pochteca" appears in SEMARNAT's list and "Pochteca Materias Primas" appears in INEGI, the ownership-walking functions (already shipped in PR #347) consolidate them as one entity. Same for "Veolia" appearing in multiple subsidiaries across Latin American jurisdictions. **The environmental services rolodex inherits the consolidation discipline already implemented for refineries and traders.**
- **News events** — the existing `entity_news_events` infrastructure tags news involving environmental services operators the same way it tags news involving refineries. Distress signals (bankruptcy filings, license revocations, environmental violations) surface automatically.
- **Customs context (work item 5)** — most environmental services are domestic services and don't show up in customs data, but a small subset (mobile thermal desorption units, specialty chemicals) may appear in HS code 8479.82 (industrial machinery) or 3815.90 (chemical reaction initiators). The customs context tool handles this opportunistically.

The environmental services category does **not** participate in:

- Slate-fit (work item 1) — irrelevant; this is for crude grades
- Cargo trips (work item 4) — irrelevant; this is for tanker movements
- Match queue feedback (work item 3) — for now. If environmental services becomes a meaningful deal flow source, the match queue can be extended to include this category, but it's premature today.

---

## 9. Operational sequencing

Recommended order of execution:

**Week 1** — Phase 1 (clean structured sources)
- Day 1: schema additions, taxonomy reference data, ingestion scaffolding
- Days 2-3: EPA RCRA Info ingestion + entity creation
- Day 4: IBAMA CTF Brazil ingestion (CNPJ-by-CNPJ, batched)
- Day 5: ANLA Colombia open-data ingestion + Energy Dais cross-reference

**Weeks 2-4** — Phase 2 (Latin American regulator registries)
- Week 2: Mexico SEMARNAT (15 rubros, OCR pipeline, ~300-500 entities)
- Week 3: Colombia CARs (5 priority regions) + Argentina provinces
- Week 4: Other Latin American sources (Peru, Ecuador, Trinidad, Guyana) opportunistically; deduplication pass; Phase 2 cleanup

**Week 5** — Phase 3 (contact enrichment)
- Days 1-2: tier scoring, Apollo/Cognism integration
- Days 3-5: Tier 1 enrichment (~50 entities), Tier 2 enrichment (~150 entities)

**Week 6** — Assistant tools and validation
- Days 1-2: chat tool implementation + system prompt integration
- Days 3-5: validation passes — sample 30 entities across phases, manually verify accuracy of regulator licensing, capability metadata, and contact data

Total: ~6 weeks of calendar time, though Phase 1 and parts of Phase 2 can run in parallel.

---

## 10. Why this category specifically — and why now

A reasonable question is whether this is the right next category to build versus other adjacencies. The case for environmental services specifically:

**It's the most likely adjacent capability to come up in existing conversations.** Refinery turnarounds, decommissioning, plant maintenance, drilling waste, contaminated site cleanup — these are conversations VTC's existing counterparties have multiple times per year. Other adjacencies (legal services, insurance brokers, customs brokers) are also relevant but less frequently surface as the deal-shaping question.

**The data is unusually amenable to structured extraction.** Regulator registries with verified licensure are higher-quality input data than most categories would have. A rolodex built from regulator data is structurally more credible than one built from website scraping.

**The regulatory environment is shifting in ways that make this more relevant, not less.** Mexico's energy sector reforms, Colombia's evolving environmental licensing framework, Brazil's increased CTF enforcement, US engagement with Venezuela's refinery restoration — all of these create more opportunities for adjacent capability questions. **Building the rolodex now positions VTC for the next 24-36 months of regional industry activity.**

**The work itself is bounded and unambiguous.** Unlike speculative ingestion ("let's add news from a fifth source and see if it matters"), this brief has a clear scope, clear sources, and clear deliverables. The risk of running over time is low; the risk of producing low-value output is low.

Compared to other potential next-category additions:

| Category | Relevance to VTC's work | Data accessibility | Estimated build effort |
|---|---|---|---|
| **Environmental services** | High — touches every operator | High — regulator registries | 3-4 weeks |
| Insurance / surety brokers | Medium — touches deal structures | Low — relationship-mediated, no public registry | 6+ weeks, low confidence |
| Customs brokers | Medium — touches every cargo | Medium — varies by country | 4-5 weeks |
| Inspection / SGS-style | Medium — touches every cargo | Medium — public agency registries | 3-4 weeks |
| Marine bunker suppliers | Low — narrow use case | High — port directories | 2-3 weeks |
| Legal / law firms | Medium — touches sanctions and structure | Low — Chambers/Legal500 directories | Long, high noise |

Environmental services is the highest-relevance / highest-tractability combination. **It's the right next category. Other adjacencies follow if and when this one validates the pattern.**

---

## 11. Success metrics

How to know if this work was worth doing, six months after Phase 3 completes:

- **Coverage**: ≥1,500 entities populated, ≥80% with regulator-verified licensing, ≥200 with contact-level enrichment
- **Operational use**: the chat tools (`find_environmental_operators_for_waste_type`, `find_environmental_operators_for_country`) get called ≥10 times in real conversations over the six-month window
- **Deal touch**: at least one VTC deal or origination conversation references environmental services capability that was identified through the rolodex (the bar isn't a closed deal — it's the rolodex being the source of the answer to a real question)
- **Maintenance overhead**: the periodic refresh runs successfully without manual intervention; new regulator data flows in monthly/quarterly without breaking ingestion

If after six months none of these metrics are met, the rolodex is stale infrastructure and the category should be deprioritized for refresh investment. If at least three are met, the category is delivering and warrants continued investment (additional regulator sources, deeper enrichment, expanded capability metadata).

---

## 12. What this brief sets up for the future

A few extensions that this rolodex enables once it's populated, deliberately not in scope for the initial build:

- **Environmental services pricing benchmarks** — analogous to `commodity_prices` for fuel and crude. Industry pricing for thermal desorption per ton, bioremediation per cubic meter, transport per ton-km. Would inform whether a project economic structure makes sense at quoted prices.
- **Capability-fit calculator** — analogous to slate-fit for crude grades. Given a waste profile (volume, contamination type, location), the system identifies which operators in which jurisdictions can technically handle the project, with confidence scoring.
- **Permit-status monitoring** — automated checking of regulator registries to detect when an operator's license expires, gets revoked, or changes scope. Same pattern as the `entity_news_events` distress signal layer, applied to regulatory status.
- **Cross-category integration** — when a refinery in procur surfaces a turnaround event in news, the system suggests environmental services operators with prior work for that refinery's parent company. Cross-pollination across categories.

These are extensions for after the foundation is solid. The brief above is the foundation.

---

End of environmental services rolodex brief.
