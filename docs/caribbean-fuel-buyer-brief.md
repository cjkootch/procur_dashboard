# Caribbean Fuel Buyer Rolodex — Expansive

**Status:** spec, not yet implemented
**Owner:** Cole
**Last updated:** 2026-05-04
**Repo:** `cjkootch/procur_dashboard`
**Companion to:** `docs/strategic-vision.md` (procur as the entity rolodex), `docs/commercial-strategy.md` (Caribbean refined product as VTC's daily cash engine), `docs/data-graph-connections-brief.md` (the connections this category will participate in once populated), `docs/deal-structures-catalog-brief.md` (the templates that match these buyers)

This brief specifies a structurally complete buyer rolodex for refined fuel in the Caribbean. The category models the demand side of the refined product market — utilities, mining operations, marine bunker suppliers, aviation fuel handlers, agricultural operations, government fleets, industrial distributors, retail networks, and the smaller segments — at the cargo-size purchase level (5,000 MT and up).

Total estimated effort: ~2-3 weeks across three phases. Hand-curated where the universe is small and well-disclosed; ingested where structured public data exists; cross-referenced where commercial directories add coverage.

The brief is structured to surface the *expansive* universe rather than the easy-to-find one. The strategic argument: VTC works with Caribbean refineries who need buyers; the bottleneck on running deal flow at scale is buyer-side coverage, not refinery-side relationships. Closing that gap is the highest-leverage near-term commercial work.

---

## 1. Why this brief exists

VTC has cultivated relationships with Caribbean refineries on the supply side. The system currently models utilities and a partial set of industrial distributors as buyers but is structurally light on the broader buyer universe — mining, marine bunker, aviation, agricultural, government fleets, large hotel/resort operators, construction contractors, retail networks operating at cargo-import scale.

This gap is the limiting factor on running refined fuel intermediation at the volume VTC's infrastructure can support. The proactive matching engine, the supplier KYC infrastructure, the deal structure catalog, the slate-fit reasoning — all assume the system can identify viable buyers for a given cargo. Without a more complete buyer rolodex, the matching engine surfaces the same handful of buyers repeatedly while leaving most of the actual demand universe invisible.

The strategic vision document called for VTC to operate at the level of a 30-person commodity trading desk with a small team. That asymmetry only manifests if the buyer-side coverage is comparable to what a 30-person desk would maintain. **This brief closes that gap.**

A specific data point that illustrates the scale of the gap, drawn from a 2025 verification of Petrojam's public disclosures: Jamaica's annual petroleum consumption is approximately 26 million barrels, of which Petrojam refines and supplies only ~54%. The remaining 46% — about 12 million barrels per year — is imported as finished product. Of that, **bauxite companies import approximately 9 million barrels annually for their own operations**, and multinational marketing companies import the remaining ~3 million directly. The bauxite industry alone is a buyer segment in Jamaica importing roughly 9M barrels of refined product per year — the equivalent of 30+ Aframax cargoes annually — and almost none of those buyers are currently in the VTC rolodex. **Multiply this pattern across the Caribbean and the gap is meaningful.**

---

## 2. What this brief deliberately doesn't include

- **Refineries themselves as buyers.** Refineries do periodically buy finished product to supplement their refining when production falls short of demand (Petrojam's own disclosures confirm this for ULSD). But they are already in the rolodex on the supply side. The buyer-side flag is captured as a metadata attribute on existing refinery entities, not as a new rolodex category.
- **Retail gasoline stations as primary entries.** Individual gas stations don't buy at cargo scale. Their parent distributor networks (Texaco / Chevron Caribbean, Shell Caribbean, Esso, Rubis, regional independents) are the cargo-size buyers and *those* are first-class entries.
- **Bunker fuel cargoes consumed by individual vessels.** Vessels are not the buyer of record; the bunker supplier or terminal that fuels them is. Vessels are tracked through the existing AIS infrastructure (PR #350 cargo trips); buyers are tracked here.
- **LNG and LPG buyers as primary entries.** Different market structure (long-term contracts dominated, smaller spot universe). LPG distributors are captured as a segment but the LNG/LPG buyer universe is a separate brief if and when it warrants one.
- **Caribbean buyers of crude oil for refining.** That's the supply side of the existing refinery rolodex, not the buyer rolodex.
- **Speculation about Cuba-related buyers in this brief.** Cuba's fuel buyer universe is its own complex sanctions-and-perimeter question, addressed through Vector Antilles framework with counsel review per `docs/specialty-crude-strategy.md`. This brief covers Cuba's *publicly-disclosable* buyer universe (state-owned utilities and certain industrial sectors) at a high level; deeper Cuba modeling lives in a separate workstream.

---

## 3. The category schema

A new value for `known_entities.role`:

```typescript
type EntityRole =
  | 'refiner'
  | 'trader'
  | 'producer'
  | 'fuel-distributor'        // already exists
  | 'utility'                  // already exists
  | 'environmental-services'   // from earlier brief
  | 'fuel-buyer-industrial';   // NEW — for industrial buyers at cargo scale
```

Plus a structured metadata layer for fuel buyer entities:

```typescript
interface FuelBuyerProfile {
  /** Primary segment classification. Multi-select supported because
   *  some entities span segments (e.g. a state-owned utility that
   *  also operates aviation fuel handling at the airport). */
  segments: Array<
    | 'utility-power-generation'
    | 'utility-water-desalination'
    | 'mining-bauxite-alumina'
    | 'mining-nickel'
    | 'mining-gold'
    | 'mining-other'
    | 'marine-bunker-supplier'
    | 'marine-cruise-line-fueling'
    | 'aviation-fuel-handler'
    | 'aviation-airline-direct'
    | 'agricultural-cooperative'
    | 'agricultural-large-estate'
    | 'industrial-distributor'
    | 'industrial-construction-contractor'
    | 'industrial-cement-aggregate'
    | 'industrial-manufacturing'
    | 'government-military'
    | 'government-public-works'
    | 'government-public-transport'
    | 'hospitality-hotel-resort'
    | 'hospitality-cruise-line-corporate'
    | 'retail-distributor-network'
    | 'lpg-distributor'
    | 'forestry-logging'
    | 'fishing-fleet-operator'
  >;

  /** Fuels purchased at cargo scale. */
  fuelTypesPurchased: Array<
    | 'gasoline-87' | 'gasoline-90' | 'gasoline-95'
    | 'diesel-ulsd' | 'diesel-lsd' | 'diesel-marine-gasoil'
    | 'jet-a-1' | 'jet-jp8'
    | 'hfo-380cst' | 'hfo-180cst'
    | 'vlsfo' | 'lsmgo'
    | 'kerosene' | 'avgas-100ll'
    | 'lpg-propane' | 'lpg-butane'
    | 'asphalt' | 'bitumen'
  >;

  /** Typical purchase volume in barrels per year, with confidence. */
  annualPurchaseVolumeBblMin: number | null;
  annualPurchaseVolumeBblMax: number | null;
  annualPurchaseVolumeConfidence: 'public-disclosure' | 'estimated-from-capacity'
                                  | 'estimated-from-industry-norms' | 'unknown';

  /** Typical cargo size when buying at cargo scale. */
  typicalCargoSizeMt: { min: number; max: number } | null;

  /** How procurement is structured. */
  procurementModel: 'term-contract-dominant' | 'spot-dominant' | 'hybrid'
                  | 'tender-only' | 'unknown';

  /** Where procurement decision authority sits. Drives outreach
   *  targeting — central procurement teams need different framing
   *  than facility-level operations managers. */
  procurementAuthority: 'centralized' | 'regional' | 'facility-level' | 'unknown';

  /** Existing supplier relationships where publicly disclosed.
   *  Often surfaces from regulatory filings, government contract
   *  databases, news coverage. */
  knownSuppliers: string[];

  /** Geographic operations within the Caribbean. ISO-2 codes. */
  caribbeanCountriesOperated: string[];

  /** Where the entity's procurement decision happens (may be
   *  outside the Caribbean for multinational entities). */
  decisionMakerCountry: string | null;

  /** Payment infrastructure capability. Some smaller buyers cannot
   *  open LCs; others have full LC capability with Tier 1 banks. */
  paymentInstrumentCapability: Array<
    | 'lc-sight' | 'lc-deferred' | 'cad' | 'tt-prepayment'
    | 'tt-against-docs' | 'open-account' | 'escrow'
    | 'sblc-backed'
  >;

  /** Banks the entity uses (where publicly disclosed).
   *  Useful for OFAC pre-screening and LC routing. */
  knownBanks: string[];

  /** Whether the buyer is state-owned, state-adjacent, private, or
   *  multinational subsidiary. Drives outreach approach and
   *  compliance perimeter. */
  ownershipType: 'state-owned' | 'state-adjacent' | 'private-domestic'
                | 'multinational-subsidiary' | 'cooperative' | 'unknown';

  /** Tier classification for engagement priority.
   *  Tier 1: top buyers in segment, high cargo volume, known
   *          procurement processes — engage proactively
   *  Tier 2: meaningful buyers, moderate volume, less mapped
   *          processes — engage opportunistically
   *  Tier 3: smaller or less validated buyers — track for now */
  tier: 1 | 2 | 3 | null;

  /** Primary contact information when known. Layered into
   *  entity_contact_enrichments via Phase 3. */
  primaryContactRole: string | null;
  primaryContactName: string | null;

  notes: string;
  confidenceScore: number;  // 0.0-1.0
}
```

The metadata sits at `known_entities.metadata.fuelBuyerProfile`. No migration required — `metadata` is already `jsonb`.

---

## 4. The Caribbean buyer universe — segment by segment

This section catalogs the segments and proposes initial seed entities for each. The seed list is illustrative of the *structure* of the rolodex; the population work in Phases 1-2 expands each segment substantially.

### 4.1 Utilities — power generation

The largest cargo-volume buyers in most Caribbean markets. Most island grids are still significantly oil-fired, particularly for baseload and peaking, with HFO and ADO as the dominant fuels. LNG and renewables are growing but oil demand remains substantial.

**Initial seed entities (illustrative of segment):**

- **Jamaica Public Service Company (JPS)** — Jamaica's monopoly electric utility. HFO and ADO consumption for thermal generation. Procurement through Petrojam primarily, with some direct imports. Ownership as of 2025: 40% Marubeni Corporation, 40% Korea East-West Power (KEPCO/EWP), 19.9% Government of Jamaica, ~0.1% minority shareholders.
- **JPS Old Harbour Bay Power Station** — major HFO consumer, transitioning to LNG.
- **Jamaica Energy Partners (JEP)** — independent power producer, HFO consumer.
- **DOMLEC (Dominica Electricity Services)** — small island utility, ADO and HFO.
- **GRENLEC (Grenada Electricity Services)** — small island utility, ADO and HFO.
- **LUCELEC (Lucia Electricity Services)** — St. Lucia, ADO and HFO.
- **VINLEC (St. Vincent Electricity Services)** — ADO and HFO.
- **BLPC (Barbados Light & Power)** — ADO and HFO, transitioning generation mix.
- **Bahamas Power and Light (BPL)** — significant HFO and ADO consumer; Bahamas imports almost everything.
- **EdH (Électricité d'Haïti)** — Haiti's national utility, ADO and HFO when supply is available.
- **EGE Haina** (Dominican Republic) — major IPP, multiple thermal plants, HFO consumption.
- **AES Andrés (Dominican Republic)** — natural gas and HFO operations.
- **CESPM (Dominican Republic)** — IPP, HFO.
- **Empresa de Generación Eléctrica Itabo (EGE Itabo)** — Dominican Republic, HFO consumer.
- **Aqualectra** (Curaçao) — utility, HFO.
- **Anguilla Electricity Company (ANGLEC)** — small island, ADO.
- **WAPA US Virgin Islands** — multiple plants, ADO and HFO.
- **PREPA Puerto Rico** — significant HFO and ADO consumer despite ongoing restructuring; under federal oversight.
- **Belize Electricity Limited (BEL)** — ADO and HFO, partial diesel-fired generation.
- **Trinidad and Tobago Electricity Commission (T&TEC)** — primarily natural gas but some HFO backup.
- **Suriname's EBS (NV Energiebedrijven Suriname)** — ADO consumer.
- **GuySuCo / GPL (Guyana Power and Light)** — ADO and HFO consumption with rapidly evolving demand.

This is roughly 20-25 utilities at Tier 1 visibility. The full Caribbean utility universe across all islands totals ~40-50 entities once smaller utility cooperatives, off-grid operators, and microgrid projects are included.

**Public-data sources for utility expansion:**
- CARILEC (Caribbean Electric Utility Services Corporation) member directory
- Country-specific energy ministry filings
- IDB and CDB project databases (utility loan disclosures with capacity data)
- Annual reports for publicly-disclosed utilities

### 4.2 Mining — bauxite, alumina, nickel, gold

The Caribbean's mining sector is the largest non-utility cargo-volume buyer segment. Bauxite/alumina dominates in Jamaica and Suriname; ferronickel in Dominican Republic; gold in Suriname, Dominican Republic, Haiti.

**Critical insight from Petrojam's public disclosures:** Jamaica's bauxite companies import approximately 9 million barrels of refined fuel annually for their operations, representing about 35% of Jamaica's national petroleum consumption. This is direct cargo-scale buying that bypasses Petrojam entirely.

**Initial seed entities:**

- **JISCO Alpart (Jamaica)** — alumina refinery in Nain, St. Elizabeth, 100% owned by China's Jiuquan Iron & Steel Group since 2016. **Status note: operations have been suspended since 2019 for a $1.1B modernization and expansion program. Phased reopening was targeted for Q4 2025; verify current operational status before treating as active buyer.** When operating, the largest Jamaican alumina-side fuel consumer.
- **Noranda Bauxite (Jamaica)** — bauxite operation, direct importer.
- **Windalco / Jamalco** (Jamaica) — alumina refining, direct importer.
- **New Day Aluminum** (Jamaica) — bauxite-alumina, importer.
- **Suralco / Newmont Suriname** — Suriname mining (legacy Suralco operations under transition).
- **IAmGold Rosebel (Suriname)** — gold mining operation, fuel-intensive.
- **Newmont Merian (Suriname)** — gold mining, significant diesel consumption.
- **Falconbridge Dominicana (Falcondo)** — Dominican Republic ferronickel operation in Bonao. Owned by Americano Nickel Ltd (a subsidiary of Bahamas-based Global Special Opportunities Ltd) since August 2015 when Americano acquired the operation from Glencore. Operations have been intermittent since the acquisition; verify current production status before treating as active fuel buyer at scale.
- **Barrick Pueblo Viejo** (Dominican Republic) — gold mine, large fuel buyer.
- **Goldcorp / Newmont Cerro de Maimón** (Dominican Republic) — copper-gold, fuel buyer.
- **Cementos Cibao / various cement operations** (DR, Jamaica, Trinidad) — cement industry is fuel-intensive (HFO and pet coke).

This is 10-15 Tier 1 mining buyers across the major Caribbean producers. The full universe with smaller operations and quarrying companies expands to 30-50 entities.

**Public-data sources:**
- USGS Minerals Yearbook (Caribbean chapter)
- IDB and World Bank mining sector filings
- Country-specific mining ministry registries (Jamaica Bureau of Mines, Dominican Republic Ministry of Energy and Mines, Suriname GMD)
- Environmental impact assessments (often disclose fuel consumption)
- Annual reports for publicly-traded operators

### 4.3 Marine bunker suppliers and cruise line fueling

Caribbean ports are major bunker hubs because of cruise traffic, transshipment volume at Kingston/Caucedo/Freeport/Cartagena, and the Panama Canal traffic that bunkers in the region.

**Initial seed entities:**

- **Petrojam (bunkering arm)** — supplies bunker fuel at Kingston Harbour.
- **Bunker Worldwide / Monjasa Caribbean** — physical bunker supplier across multiple Caribbean ports.
- **GAC Bunker Fuels** — global bunker broker with Caribbean operations.
- **World Fuel Services Caribbean** — bunker supply, Bahamas / Caribbean.
- **Aegean Marine Petroleum (Caribbean operations)** — physical and broker bunker activity.
- **Bahamas Oil Refining Company (BORCO / Buckeye Bahamas)** — major Bahamas terminal, bunker capability.
- **Statia Terminals (St. Eustatius)** — large terminal with bunker services.
- **Curaçao bunker operators (Curaçao Oil Storage / Aspen Bunkering / Curoil)** — multiple bunker suppliers active at the port of Willemstad.
- **Trinidad bunker operators (Petrotrin successor entities)** — Pointe-à-Pierre bunker activity.
- **Carnival Cruise Line corporate fuel procurement** — direct buyer for the Carnival fleet, makes Caribbean port calls.
- **Royal Caribbean fuel procurement** — direct buyer, headquartered Miami but serves Caribbean.
- **Norwegian Cruise Line fuel procurement** — same pattern.
- **MSC Cruises fuel procurement** — same pattern.

10-15 Tier 1 marine bunker entities. The broader universe of barge operators, smaller bunker brokers, and individual port-based bunker stations expands the count further.

**Public-data sources:**
- IBIA (International Bunker Industry Association) member directory
- Lloyd's List Intelligence bunker supplier listings
- Port authority directories (Kingston Wharves, Caucedo, Freeport, San Juan, Curaçao Ports Authority)
- Bunker port directory annuals (Petromedia, Argus)

### 4.4 Aviation fuel handlers and direct airline buyers

Caribbean tourism drives substantial Jet-A consumption. Airport fuel handlers at major hubs are cargo-scale buyers; some airlines purchase directly through master contracts that touch the Caribbean.

**Initial seed entities:**

- **MZJ World Fuel Services** — handles aviation fueling at multiple Caribbean airports.
- **Air BP** — global aviation fuel supplier, active in Caribbean.
- **Shell Aviation** — Caribbean airport coverage.
- **ExxonMobil Aviation Caribbean** — multiple airport contracts.
- **Chevron Aviation** — Caribbean airport fueling.
- **Cargill Aviation Fuels** — niche supplier.
- **Avianca direct fuel procurement** (Colombia / DR / wider Caribbean).
- **Copa Airlines fuel procurement** (Panama-based but heavy Caribbean network).
- **Caribbean Airlines** (Trinidad-based, regional carrier).
- **InterCaribbean Airways** (Turks & Caicos-based).
- **Cayman Airways**.
- **Bahamasair**.
- **Sangster International (Montego Bay) fuel handler** — major tourism gateway.
- **Punta Cana International Airport fuel handler** — Dominican Republic's largest tourism airport.
- **San Juan Luis Muñoz Marín Airport fuel handler** — Caribbean hub.
- **Nassau Lynden Pindling Airport fuel handler**.
- **Cancún International Airport fuel handler** (Mexico but Caribbean-adjacent demand).

10-12 Tier 1 aviation fuel buyers. Full universe with smaller airports and FBOs (fixed-base operators) expands to 25-35.

**Public-data sources:**
- IATA member airline directory
- ACI (Airports Council International) Latin America-Caribbean directory
- Country aviation authority filings
- Master fuel handler agreements (often disclosed at major airports)

### 4.5 Industrial distributors at cargo-import scale

Distributors that import finished product for breakdown into smaller markets. Some are multinational subsidiaries; many are domestic independents. These are the main alternative channel to refinery-direct buying.

**Initial seed entities — multinational presence in Caribbean:**

- **Texaco / Chevron Caribbean** — Caribbean retail and industrial fuel network.
- **Shell Caribbean** — multiple country operations, cargo-import scale.
- **Esso Caribbean / ExxonMobil** — refined product import operations.
- **Rubis Caraïbes** — major fuel distributor across French and Anglo Caribbean.
- **Sol Petroleum Caribbean** — regional independent, multi-island distributor.
- **Total Energies Caribbean** — mostly French Caribbean.
- **Parkland Caribbean (formerly Sol Group)** — pan-Caribbean retail and industrial.

**Domestic independents and regional players:**

- **GB Energy (Guyana)** — fuel distributor.
- **Gas y Servicios (Dominican Republic)** — independent distributor.
- **Sigma Alimentos** — general distribution including fuel in DR.
- **National Petroleum (Jamaica)** — independent distributor.
- **Caribbean Fuels Limited (multiple islands)** — smaller independent.
- **Bayport Energy (Bahamas)** — independent distributor.
- **Petrocaribe distributors** — surviving country-by-country distribution arms (DR, Jamaica, Belize, Haiti, Suriname remnants).

10-15 Tier 1 industrial distributors with broader expansion to 30-40 across the Caribbean.

**Public-data sources:**
- Country-specific fuel distributor licensing (Bureau of Standards Jamaica, ProConsumidor DR)
- Industry association directories (Cámara Petrolera de la República Dominicana)
- Customs data showing import volumes by entity
- News coverage of fuel distributor transactions

### 4.6 Construction and infrastructure contractors

Large infrastructure programs in DR, Jamaica, Trinidad, Bahamas, and Caribbean-wide tourism expansion drive cargo-scale fuel purchases for equipment fleets.

**Initial seed entities:**

- **Acciona Infraestructuras (DR projects)** — large highway and infrastructure programs.
- **OHLA (formerly OHL) Caribbean operations** — Spanish construction firm with significant DR work.
- **Estrella Construction (Dominican Republic)** — major domestic contractor.
- **JISCO and Jamaican infrastructure programs**.
- **NIDCO / various Trinidad infrastructure contractors**.
- **CHEC (China Harbour Engineering) Caribbean operations** — multiple ongoing projects.
- **PowerChina Caribbean projects**.
- **Tropic Glass / various large Caribbean construction firms**.

5-10 Tier 1 entities; broader universe is project-by-project and harder to mapsystematically.

**Public-data sources:**
- IDB project disclosures (loan documents identify general contractor)
- Country-specific public works ministry contract awards
- Major project announcements via trade press

### 4.7 Government and military fleets

State-owned fuel buyers outside utilities: military operations, police vehicle fleets, public transport fleets, public works equipment, port authority operations.

**Initial seed entities (illustrative):**

- **Jamaica Defence Force fuel procurement** — military fleet.
- **Dominican Republic Ministry of Defense fuel procurement**.
- **Trinidad and Tobago Defence Force**.
- **Bahamas Defence Force**.
- **Jamaica Urban Transit Company (JUTC)** — public transport, diesel fleet.
- **Office of Disaster Preparedness (ODPEM Jamaica)** — emergency fuel reserves.
- **Various country police vehicle fleets**.
- **Country port authorities (Kingston Wharves, Port of Spain, Bridgetown, Cap-Haïtien) operating their own fuel for cargo handling equipment**.

5-10 Tier 1; full government fleet universe expands meaningfully across all Caribbean states.

**Public-data sources:**
- OCDS expansion (procurement records — already partially ingested by procur)
- Government gazettes and procurement award disclosures
- Defense ministry annual reports

### 4.8 Hospitality — hotels, resorts, cruise lines (corporate)

Large resort operators with their own backup generation, fuel storage, and marine bunkering in some cases. Cruise lines as corporate buyers (separate from operational vessel-level bunker purchases).

**Initial seed entities:**

- **Bahá Príncipe** (DR, Jamaica) — major resort chain with backup generation needs.
- **Iberostar Caribbean operations**.
- **Riu Hotels Caribbean operations**.
- **Sandals Resorts Caribbean** — multiple islands, generator-equipped properties.
- **Atlantis Paradise Island (Bahamas)** — significant fuel infrastructure.
- **Sandy Lane (Barbados)**.
- **Half Moon Bay (Jamaica)** — older property with significant infrastructure.
- **Atlantis Cancún and Riviera Maya operations** (Mexico Caribbean).

5-10 Tier 1 hotel/resort buyers; broader universe is most relevant for backup-generation diesel and LPG cooking fuel.

**Public-data sources:**
- IDB hospitality sector disclosures
- Country-specific tourism authority filings
- Sustainability/ESG reports from major chains (often disclose fuel consumption)

### 4.9 Agricultural cooperatives and large estates

Agricultural fuel demand is significant in DR, Haiti, Cuba, Jamaica, Trinidad, and the broader Caribbean for irrigation, equipment fleets, processing facilities.

**Initial seed entities:**

- **Banelino** (DR banana cooperative).
- **Coopharina / Coopharimar** (DR).
- **Centroamericana de Equipos** (DR agricultural equipment).
- **Jamaica Sugar Industry / Worthy Park Estate** — sugar producers, fuel-intensive processing.
- **Trinidad agricultural cooperatives**.

5-10 Tier 1; broader agricultural universe is fragmented and less well-disclosed than other segments.

**Public-data sources:**
- USDA FAS Caribbean reporting (already a contact point for VTC's food commodity work)
- Country-specific agriculture ministry registries
- Cooperative directories

### 4.10 LPG distributors

LPG is used widely for cooking fuel and small commercial heating in the Caribbean. LPG distributors operate as a distinct sub-segment because the supply chain (trucked from terminals, cylinder-based delivery) is different from gasoline/diesel.

**Initial seed entities:**

- **Tropigas Dominicana** (DR) — major LPG distributor.
- **Propagas (DR)** — already in rolodex on supplier-side; also an LPG distributor.
- **Fersan / Coral Energy** (DR) — petroleum distribution.
- **Massy Gas Products (Trinidad)**.
- **National Gas Company (Trinidad)** — natural gas focus but LPG operations.
- **Petrojam LPG distribution**.
- **Bahamas Gas Companies** (multiple).

5-10 Tier 1 LPG distributors.

### 4.11 Other segments — forestry, fishing, smaller industrials

Lower-priority for initial Tier 1 mapping but worth capturing as the rolodex matures:

- **Fishing fleet operators** in Cuba, DR, Jamaica, Haiti, Bahamas (regional fishing cooperatives buy diesel for fleets)
- **Forestry operations** in Belize, Suriname, Guyana
- **Manufacturing operations** with significant onsite fuel consumption (textile, food processing, beverage)
- **Aluminum and copper smelters** (Suriname's legacy operations, ongoing operations elsewhere)

These expand the rolodex from ~150 Tier 1+2 entities to potentially 250-350 entities at full coverage.

---

## 5. Phase 1 — Tier 1 hand-curation (1 week)

Phase 1 focuses on hand-curating the Tier 1 universe across all 11 segments with structured metadata. This is the highest-leverage rolodex work because Tier 1 entities account for the vast majority of cargo-scale buying activity.

Target: 100-150 Tier 1 entities populated with full metadata.

Approach:
- Day 1-2: Utilities (segments 4.1) — most public-disclosure-heavy segment, fastest to populate.
- Day 2-3: Mining and industrial distributors (segments 4.2 and 4.5) — second-tier disclosure depth.
- Day 3-4: Marine bunker, aviation, government (segments 4.3, 4.4, 4.7) — moderate disclosure.
- Day 5-7: Construction, hospitality, agricultural, LPG (segments 4.6, 4.8, 4.9, 4.10) — thinner disclosure but bounded universe.

Each entry includes: entity name, segments, fuel types purchased, estimated annual volume (with confidence flag), procurement model, geographic operations, ownership type, tier classification, notes. Contact-level enrichment deferred to Phase 3.

### 5.1 Phase 1 deliverables

- 100-150 Tier 1 entities populated
- Reference taxonomy file `packages/catalog/src/fuel-buyer-taxonomy.ts` exporting the segment, fuel type, and procurement model enums as TypeScript const arrays
- Initial metadata population validated through cross-reference with multiple public sources where possible

---

## 6. Phase 2 — Tier 2 expansion via structured ingestion (1-2 weeks)

Phase 2 expands the rolodex by ingesting structured data from public sources that surface buyer entities procur doesn't yet have.

### 6.1 OCDS expansion to Caribbean fuel procurement

The proactive matching engine already ingests OCDS (Open Contracting Data Standard) procurement records for several jurisdictions. Phase 2 extends OCDS coverage to Caribbean fuel-specific tenders:

- Jamaica Public Procurement (electronicrequest.gov.jm and the Office of the Contractor-General feeds)
- Dominican Republic DGCP (Dirección General de Contrataciones Públicas)
- Trinidad and Tobago Office of Procurement Regulation
- Bahamas central tender disclosures
- Barbados National Insurance Office and government procurement
- Guyana NPTAB (National Procurement and Tender Administration Board)
- IDB and CDB project tender records (already partially ingested)

Buyers who issue tenders for fuel (ULSD, gasoline, jet, HFO, asphalt) populate as candidate entities in the rolodex. Repeat tender issuers are likely high-value buyers.

Estimated entity additions: 20-50 entities not in Tier 1, primarily in government, utilities, and construction segments.

### 6.2 Customs flow expansion

Customs records (where publicly available) show direct fuel imports by entity. UN Comtrade has Caribbean coverage at the country level; some Caribbean customs authorities publish entity-level data:

- Jamaica Customs Agency
- DGA Dominican Republic
- Customs and Excise Trinidad
- Bahamas Customs

Where entity-level customs data is available, it surfaces buyers importing at cargo scale that may not appear in OCDS data (private mining operators, large industrial buyers).

Estimated entity additions: 20-30 entities.

### 6.3 CARILEC and industry directory ingestion

CARILEC member directory provides a structured list of Caribbean utilities. IBIA member directory provides bunker suppliers. ACI member directory provides airport authorities. These are smaller datasets but high-quality for their respective segments.

Estimated entity additions: 30-50 entities (mostly enrichment of Tier 1 and population of Tier 2 in utility, marine, aviation segments).

### 6.4 Phase 2 deliverables

- OCDS Caribbean fuel tender ingestion
- Customs flow integration where available
- Industry directory cross-reference
- Tier 2 population: 70-130 additional entities
- Total rolodex by end of Phase 2: 170-280 entities

---

## 7. Phase 3 — Contact enrichment (3-5 days)

Phase 3 layers contact-level data onto the Tier 1 entities (and selected Tier 2 entities with active deal potential). Same pattern as the environmental services rolodex Phase 3:

- Apollo or Cognism API for Tier 1 entities (top 100-150)
- Procurement decision-maker contacts (CEOs, COOs, CFOs, procurement directors, fuel procurement managers, plant managers)
- Verified email addresses and phone numbers
- LinkedIn URLs for credibility verification

Writes to existing `entity_contact_enrichments` table.

Estimated cost: $400-800 in API calls for Tier 1 enrichment. Tier 2 enrichment opportunistic as deals materialize.

### 7.1 Phase 3 deliverables

- Approximately 100-150 contactable Tier 1 entities with verified decision-maker contacts
- Tier 2 entities tagged for opportunistic enrichment when deals warrant

---

## 8. Assistant tools

Three new chat tools that make the buyer rolodex queryable from procur's assistant interface and from vex via the existing intelligence HTTP API:

```typescript
/**
 * Find fuel buyers matching specified segment, fuel type, and
 * geographic criteria. Use when sourcing buyers for a specific
 * cargo or when assessing the universe of demand for a region.
 */
find_caribbean_fuel_buyers(args: {
  segments?: string[];           // From segments enum
  fuelTypes?: string[];          // From fuelTypesPurchased enum
  inCountries?: string[];        // ISO-2 codes
  minAnnualVolumeBbl?: number;
  ownershipTypeFilter?: string;
  tier?: 1 | 2 | 3;
  withPaymentInstrumentCapability?: string[];
}) => FuelBuyerMatch[]

/**
 * Given a specific cargo (volume, fuel type, discharge port),
 * return ranked candidate buyers based on geographic feasibility,
 * volume fit, and segment match. Used by the proactive matching
 * engine and by the assistant when composing outreach for a cargo
 * in hand.
 */
match_cargo_to_buyers(args: {
  fuelType: string;
  volumeMt: number;
  dischargePort: string;
  laycanWindow: { start: string; end: string };
  /** Whether to include only entities with full payment instrument
      capability matching the cargo's offered structure. */
  paymentInstrumentRequired?: string;
}) => RankedBuyerMatch[]

/**
 * Analyze a country's fuel demand structure — which segments are
 * largest, which entities dominate each segment, what's the
 * approximate volume distribution. Useful for go-to-market planning
 * for a new Caribbean market.
 */
analyze_caribbean_fuel_demand(args: {
  country: string;     // ISO-2
  fuelType?: string;   // Optional restriction to specific fuel
}) => CountryDemandSummary
```

---

## 9. Integration with existing procur capabilities

The fuel buyer category participates in the data graph connections from `docs/data-graph-connections-brief.md`:

- **Ownership graph (work item 2)** — when JISCO Alpart appears as a buyer and JISCO Group appears as the parent, the ownership-walking functions consolidate them. Same for cruise line corporate fuel procurement (Carnival Corp owns Carnival, Princess, Cunard, etc. — all fuel-buying subsidiaries with one parent procurement decision).
- **News events** — distress signals (utility procurement issues, mining operation curtailment, cruise line route changes) surface automatically through the existing `entity_news_events` infrastructure.
- **Customs context (work item 5)** — directly relevant; customs flow data anchors each buyer entity in their actual procurement pattern.
- **Match queue feedback (work item 3)** — the buyer rolodex is the demand-side population for the proactive matching engine. Matches between supplier-side opportunities and buyer-side entities feed the match_queue, which feeds the feedback loop for scoring calibration.
- **Slate-fit (work item 1)** — irrelevant for refined fuel (slate-fit is for crude grades).
- **Cargo trips (work item 4)** — opportunistic; vessel positions arriving at Jamaica's Kingston port can be inferred as discharge for Jamaican buyers, but the inference is approximate at the entity level.

The fuel buyer category integrates with the deal structures catalog:
- Tier 1 utilities and refineries with LC capability use `caribbean-refined-cif-lc-sight` or `caribbean-refined-cif-lc-deferred-30` templates
- Smaller distributors without full LC infrastructure use `caribbean-refined-cif-cad`
- Buyer-arranged-shipping operators use `caribbean-refined-fob-tt-prepayment`

---

## 10. Operational sequencing

**Week 1** — Phase 1 (Tier 1 hand-curation)
- Days 1-2: Utilities (~25 entities)
- Days 2-3: Mining + industrial distributors (~30 entities)
- Days 3-4: Marine, aviation, government (~30 entities)
- Days 5-7: Construction, hospitality, agricultural, LPG, other (~40 entities)

**Weeks 2-3** — Phase 2 (Tier 2 expansion)
- Week 2: OCDS Caribbean fuel ingestion + customs flow
- Week 3: Industry directory cross-reference, deduplication, validation

**End of week 3** — Phase 3 (contact enrichment)
- Apollo/Cognism enrichment for Tier 1 (3-5 days)

**Total: 2-3 weeks of build effort.**

---

## 11. Why this category specifically — and why now

**It's the gating step for refined fuel daily cash deal flow.** The strategy documents call for refined fuel to be VTC's daily cash engine. That requires running deal flow at volume. That requires a buyer-side rolodex deep enough to surface multiple viable buyers for any given cargo. Without this work, the refined fuel track is bottlenecked at the buyer-side coverage layer regardless of what else is built.

**The data exists and is partially structured.** Caribbean buyers are visible through public disclosures (utility annual reports, mining sector filings, customs data, industry association directories) more than the brief might suggest from the segment-by-segment view. The work is meaningful but not speculative; the universe is real and discoverable.

**It compounds with existing infrastructure.** Every connection in the data-graph brief becomes more useful when the buyer-side population is denser. The proactive matching engine surfaces more relevant matches when both sides of the market are well-mapped. The opportunistic plays discipline operates more usefully when buyer demand patterns are observable, not just supplier supply patterns.

**It's a prerequisite for several future capabilities.** Once the buyer rolodex is dense, the system can compute supply-demand balance per Caribbean market in near-real-time, identify regional surplus or deficit patterns, surface arbitrage opportunities between markets, and inform pricing analytics. **This brief unlocks several downstream capabilities that depend on it.**

Compared to other near-term work:

| Addition | Effort | Operational ROI | Strategic ROI |
|---|---|---|---|
| **Caribbean fuel buyer rolodex** | 2-3 weeks | Very high | Foundational for refined fuel track |
| Environmental services rolodex | 3-4 weeks | Moderate | Adjacent capability |
| Deal structures catalog | 3-5 days | High | Compounds across all categories |
| Buyer intelligence v1.5 | 2 weeks | Moderate | Proactive matching depth |

The buyer rolodex sits in the highest-leverage position for the refined fuel track specifically. **Build it next, before pursuing high-volume Caribbean refined fuel deal flow.**

---

## 12. Success metrics

How to know if this work was worth doing, six months after Phase 3 completes:

- **Coverage**: ≥150 Tier 1 entities with full metadata, ≥250 total entities (Tier 1 + Tier 2)
- **Contact enrichment**: ≥100 entities with verified decision-maker contacts
- **Operational use**: chat tools called ≥30 times in real conversations over six months
- **Match queue feeds**: ≥50% of refined fuel matches surfaced by the proactive engine reference entities from this rolodex
- **Deal touch**: at least 3 closed VTC deals in the six months reference buyers from this rolodex (the bar isn't 3 closed deals required by the rolodex specifically — it's that the rolodex is *materially used* in real deal flow)

If at least 4 of 5 metrics are met, the rolodex is delivering. If fewer, the gap analysis is informative — segment-level coverage gaps, contact-enrichment gaps, or operational-adoption gaps each suggest different next-round investments.

---

## 13. What this brief deliberately doesn't include

- **No global buyer rolodex.** Caribbean is the focus because that's where VTC's existing refinery relationships are. Global expansion is a separate brief if and when warranted.
- **No buyer scoring or willingness modeling.** Buyer engagement priority is determined per-deal-context, not stored as static rolodex metadata.
- **No automated outreach to buyers from this brief.** The rolodex is the universe; outreach happens through vex's existing campaign + supplier-approval workflow with operator review.
- **No public buyer-list publication.** The rolodex is internal operational reference.

---

End of Caribbean fuel buyer rolodex brief.
