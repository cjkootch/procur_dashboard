# Buyer Intelligence v2: Free-Source Fuel Consumption Signals

**Status:** working brief
**Owner:** Cole, in capacity as Managing Member, Vector Trade Capital LLC (and IP owner of procur)
**Last updated:** 2026-05-05
**Repo:** `cjkootch/procur_dashboard`
**Engagement context:** Buyer intelligence v2 cycle — extends the Caribbean fuel buyer rolodex foundation shipped in PRs #380, #381, #383 with high-quality fuel consumption signals derived exclusively from free primary sources

---

## 1. What this brief is and isn't

This brief catalogs free primary sources for fuel consumption intelligence on industrial, marine, aviation, mining, and utility buyers — the segments procur already covers in the Caribbean fuel buyer foundation. The goal is to extend the buyer rolodex from "this entity exists and operates here" to "this entity consumes approximately X bbl/year, with confidence Y, sourced from Z." This converts the buyer rolodex from contact infrastructure into demand intelligence infrastructure.

**It is not** a Venezuela-engagement-relevant brief. The Venezuela contractor outreach work proceeds on its own timeline using existing infrastructure. The buyer intelligence v2 work is parallel and lower-priority for the next 14 days.

**It is not** a "build everything" plan. Realistic implementation is 3-5 sources integrated over a 4-6 week cycle, not 15 sources integrated immediately. The brief catalogs the universe; selection and sequencing is the next decision.

**It is not** a paid-source brief. All sources listed are free primary sources accessible without subscription. Where paid aggregators exist (ImportGenius, Lloyd's, Sea-Web, Datamyne, S&P Capital IQ, Cirium), the brief identifies the underlying free sources those aggregators resell. The tradeoff is engineering effort: free sources require more integration work, but the data quality on specific entities is often better than paid aggregators because you're going to the primary disclosure.

---

## 2. Strategic context for the v2 cycle

The Caribbean fuel buyer foundation that shipped today (PRs #380, #381, #383) established the entity-level rolodex: known industrial, marine, aviation, mining, and utility buyers across the Caribbean basin, with chat tools, segment taxonomies, and physical-asset geocoding. **What that foundation does not yet provide is consumption signal at the entity level.**

The current state of buyer intelligence in procur:
- Entity exists in `known_entities` ✓
- Entity has segment taxonomy classification ✓
- Entity has lat/lng geocoding for physical assets ✓
- Entity has rough operational scale estimate (small / medium / large) ✓ (in some cases)
- Entity has fuel demand estimate in bbl/year with confidence level ✗
- Entity has time-series consumption pattern ✗
- Entity has fuel type breakdown (HFO / MGO / diesel / jet / gasoline) ✗
- Entity has hedging or procurement pattern signals ✗

The v2 cycle adds the missing signals. Each signal source produces evidence at different confidence levels and granularity; the system architecture aggregates across sources to produce calibrated estimates with provenance.

The strategic value of buyer intelligence v2 in commercial use:

**For specialty crude origination:** Knowing which Caribbean refineries consume which slates at what volumes lets Vector Antilles target counterparty conversations with specific commercial relevance, rather than generic refinery outreach.

**For Caribbean refined fuel work:** Knowing which industrial buyers consume meaningful diesel volumes (mining, marine, utility, aviation) lets VTC target supply conversations to buyers who have demand worth supplying, rather than chasing every entity in the rolodex.

**For deal triangulation:** When a fuel broker mentions an opportunity, the buyer intelligence layer lets Vector Antilles independently validate the demand profile claimed by the broker before committing structuring effort.

This is not about building a sellable buyer database product. It's about Vector Antilles and VTC having sharper commercial targeting than competitors who rely on broker-supplied demand information or paid aggregators.

---

## 3. Architecture decisions before integration

Three architectural decisions need to be made before any source integration:

### 3.1 Schema for `fuel_consumption_signals`

Working schema:

```sql
CREATE TABLE fuel_consumption_signals (
    id BIGSERIAL PRIMARY KEY,
    entity_slug TEXT NOT NULL REFERENCES known_entities(slug),
    signal_source TEXT NOT NULL,  -- 'cdp', 'bond_prospectus', 'eu_mrv', 'ni_43_101', etc.
    signal_kind TEXT NOT NULL,    -- 'volume_estimate', 'capacity_signal', 'expenditure_signal', 'activity_signal'
    fuel_type TEXT,               -- 'diesel', 'hfo', 'mgo', 'jet', 'gasoline', 'mixed', 'unknown'
    volume_bbl_yr NUMERIC,        -- estimated annual consumption in barrels
    volume_bbl_yr_low NUMERIC,    -- low end of range
    volume_bbl_yr_high NUMERIC,   -- high end of range
    confidence_score NUMERIC NOT NULL,  -- 0.0 to 1.0
    as_of_date DATE NOT NULL,     -- when the signal applies
    reported_date DATE,           -- when the signal was reported (different from as_of)
    source_url TEXT,
    source_doc_ref TEXT,          -- specific page/section/table reference
    source_extracted_text TEXT,   -- raw text extracted from source for audit
    derivation_notes TEXT,        -- how the volume was computed if not directly disclosed
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_fcs_entity ON fuel_consumption_signals(entity_slug);
CREATE INDEX idx_fcs_source ON fuel_consumption_signals(signal_source);
CREATE INDEX idx_fcs_as_of ON fuel_consumption_signals(as_of_date);
```

Key design choices:
- **Range-based volumes (low/high) rather than point estimates.** Most sources produce ranges, not exact figures. Storing the range preserves the uncertainty.
- **Confidence score per signal, not per source.** Different signals from the same source can have different reliability (a 2024 CDP filing has different confidence than a 2018 CDP filing).
- **Separate `as_of_date` from `reported_date`.** A 2026 ESG report disclosing 2024 emissions has reported_date 2026, as_of 2024. Critical for time-series analysis.
- **Derivation notes for computed volumes.** When converting Scope 1 emissions to diesel barrels via intensity factor, the derivation logic should be auditable.

### 3.2 Schema for `fuel_intensity_factors`

```sql
CREATE TABLE fuel_intensity_factors (
    id BIGSERIAL PRIMARY KEY,
    factor_kind TEXT NOT NULL,        -- 'diesel_per_tonne_bauxite', 'diesel_per_mwh_dieselgen', etc.
    industry_segment TEXT NOT NULL,
    factor_value NUMERIC NOT NULL,
    factor_unit TEXT NOT NULL,
    factor_low NUMERIC,
    factor_high NUMERIC,
    source_authority TEXT,             -- 'ICMM', 'IEA', 'EPA', etc.
    source_url TEXT,
    last_validated DATE,
    notes TEXT
);
```

Pure config table, low-churn. Initial seed should include:

| Factor | Value | Range | Source |
|--------|-------|-------|--------|
| diesel_per_tonne_bauxite | 2.2 L/t | 1.5-3.0 L/t | ICMM industry standard |
| diesel_per_tonne_gold_ore | 3.5 L/t | 2.0-5.0 L/t | ICMM industry standard |
| diesel_per_mwh_dieselgen | 0.27 L/kWh = 270 L/MWh | 250-310 L/MWh | EIA standard |
| hfo_per_mwh_hfogen | 0.21 L/kWh = 210 L/MWh | 195-235 L/MWh | EIA standard |
| jet_per_flight_a320 | ~2,300 kg/hr cruise | varies by route | aircraft manufacturer specs |
| co2_per_tonne_diesel | 3.16 tCO2/t diesel | 3.10-3.20 | EPA/IPCC |
| co2_per_tonne_hfo | 3.11 tCO2/t hfo | 3.05-3.15 | EPA/IPCC |
| co2_per_tonne_jet | 3.15 tCO2/t jet | 3.10-3.20 | EPA/IPCC |
| diesel_per_tonne_cement | 4.5 L/t | 3.0-7.0 L/t | WBCSD CSI |
| diesel_per_teu_port_handling | 3.5 L/TEU | 2.0-5.5 L/TEU | port industry estimates |

### 3.3 Computed view `buyer_consumption_estimate`

Aggregates signals across sources for each entity into a single calibrated estimate with provenance:

```sql
CREATE VIEW buyer_consumption_estimate AS
SELECT 
    entity_slug,
    -- weighted average across signals, weighted by confidence
    SUM(volume_bbl_yr * confidence_score) / NULLIF(SUM(confidence_score), 0) AS weighted_volume_bbl_yr,
    MIN(volume_bbl_yr_low) AS volume_bbl_yr_low,
    MAX(volume_bbl_yr_high) AS volume_bbl_yr_high,
    COUNT(*) AS signal_count,
    ARRAY_AGG(DISTINCT signal_source) AS signal_sources,
    MAX(as_of_date) AS most_recent_signal,
    AVG(confidence_score) AS avg_confidence
FROM fuel_consumption_signals
WHERE as_of_date >= NOW() - INTERVAL '36 months'
GROUP BY entity_slug;
```

**Conflict resolution:** when multiple signals disagree, the weighted average is the default. For specific use cases (e.g., "what's the most recent reported figure"), separate functions/views can produce different aggregations.

---

## 4. The source universe — Tier A (highest priority)

### 4.1 Bond prospectus and continuing disclosure mining

**What it provides.** Latin American and Caribbean industrial issuers file bond prospectuses with stock exchanges that publish them as free PDFs. These filings include 5-10 year operational projections, segment-level cost breakdowns, fuel hedging disclosures, and risk factor sections that cite specific consumption volumes. Filed under legal liability — most reliable disclosures available anywhere.

**Primary sources (all free):**
- Luxembourg Stock Exchange (bourse.lu/programme) — primary venue for LatAm eurobonds
- Singapore Stock Exchange — secondary venue, especially for Asian-affiliated mining
- Bermuda Stock Exchange — Caribbean-headquartered entities
- Cayman Islands Stock Exchange — same
- MSRB EMMA system (emma.msrb.org) — US municipal bonds including Puerto Rico, USVI utilities
- SEC EDGAR — for any US-listed entity, including foreign private issuers (20-F filings)
- CVM Brazil (cvm.gov.br) — Brazilian issuers with Caribbean operations
- Comisión Nacional de Valores Argentina — Argentine issuers

**Coverage in Caribbean basin:**
- Strong: Cementos Argos, Cemex Latam, Holcim Caribbean affiliates, JBC Bauxite (when issuing), AES Dominicana, EGE Haina, Falcondo predecessor entities
- Moderate: Dominican Republic utilities, Puerto Rico utilities (PREPA continuing disclosure)
- Weak: privately held mid-market industrials

**Integration approach.**
- Quarterly scraper across the named exchanges, filtering for industrial issuers with Caribbean/LatAm operations
- LLM-driven extraction (Claude or GPT-4) for fuel consumption mentions, hedging activity, operational projections
- Section-aware extraction: focus on "Risk Factors," "Operating and Financial Review," "Industry," and "Description of Business" sections where fuel consumption typically appears
- Audit trail: store the full extracted section text alongside the structured signal

**Integration complexity:** ~5-7 days for a working scraper + extractor. PDF parsing reliability varies; some prospectuses are scanned (require OCR), some are text-native.

**Confidence weight:** 0.85 for direct disclosure, 0.65 for derived from segment-level expenditure data.

### 4.2 EU MRV emissions database

**What it provides.** Every commercial vessel calling at EU ports reports verified annual CO2 emissions, fuel consumption (in tonnes), distance traveled, and time at sea. Data is published at vessel level with IMO number, vessel particulars, and operational metrics. **This is the single highest-quality marine fuel consumption dataset in the world, and it's free.**

**Primary source:**
- EU MRV system at mrv.emsa.europa.eu — covers all vessels above 5,000 GT calling at EU ports
- Annual reporting cycle, retrospective by 1 year (2024 data published mid-2025)
- Structured data, downloadable in Excel/CSV format

**Coverage in Caribbean basin:**
- Excellent for cargo vessels in transatlantic Caribbean trade (essentially all commercial vessels)
- Excellent for cruise vessels (almost all major cruise lines call EU ports)
- Good for tanker traffic (most product and crude tankers in transatlantic trade)
- Limited for purely intra-Caribbean shipping that doesn't touch EU ports

**Integration approach.**
- Annual download of the MRV report (Excel format)
- Map IMO numbers to vessels, vessels to operating companies, operating companies to known_entities in procur
- Cross-reference with AIS data (already in procur) to identify which vessels bunker in Caribbean ports
- Derive Caribbean bunker volumes from "% of operational time in Caribbean" × annual fuel consumption from MRV

**Integration complexity:** ~2-3 days. Data is clean and structured.

**Confidence weight:** 0.95 for direct vessel-level fuel consumption (verified by EU regulators). 0.70 for Caribbean-specific bunker volume (depends on AIS-derived activity estimation).

### 4.3 NI 43-101 mining technical reports

**What it provides.** Every publicly listed mining company on Canadian exchanges (TSX, TSX-V) is required to file NI 43-101 technical reports for material mineral projects. These reports include detailed mine plans with annual diesel consumption projections, equipment fleet assumptions, production schedules, and operating cost breakdowns. **Forward-looking, technically detailed, free, and primary.**

**Primary source:**
- SEDAR+ (sedarplus.ca) — Canadian regulatory filing system, free public access
- Filings are PDF format, technical depth varies but is generally substantial (50-300 pages)
- Updated when material changes occur in mine plan (typically every 2-5 years per project)

**Coverage in Caribbean basin:**
- Suriname gold (Iamgold's Rosebel, Newmont Merian historically, smaller operations)
- DR gold (Pueblo Viejo via Barrick — though Barrick is non-Canadian, may file equivalents)
- Bauxite operations are largely held by non-Canadian entities (Norsk Hydro, JISCO, etc.) but some smaller Caribbean projects file
- Guyana gold (multiple TSX-listed operators in active development)

**Integration approach.**
- SEDAR+ scraper filtering for mining technical reports with Caribbean basin geography
- LLM-driven extraction focusing on "Operating Costs," "Mine Plan," "Capital and Operating Costs," and "Energy and Fuel" sections
- Extract: annual diesel projections, equipment fleet (haul truck count by class), production schedule, fuel cost as % of operating cost
- Cross-reference projections with current production data from country geological surveys

**Integration complexity:** ~4-5 days for a working SEDAR+ scraper with extraction logic.

**Confidence weight:** 0.90 for projected consumption (technically validated under NI 43-101), 0.70 when applied as estimate of actual current consumption (projections vs. reality often diverge).

### 4.4 VIIRS Nighttime Lights time-series per facility

**What it provides.** Monthly composite imagery from the VIIRS satellite showing industrial activity intensity over time at any geocoded facility. Industrial facilities with active operations show consistent nighttime light signatures; facilities ramping up or down show measurable changes. Resolution is sufficient (500m) for facility-level analysis of large industrial operations.

**Primary source:**
- Earth Observation Group at Colorado School of Mines (eogdata.mines.edu/products/vnl/) — monthly composites since 2012
- Free download, no rate limits beyond standard FTP courtesy
- Format: GeoTIFF, requires geospatial processing

**Coverage in Caribbean basin:**
- Excellent for major industrial facilities (refineries, large mining operations, power plants, ports)
- Adequate for medium industrials
- Insufficient for small operations (resolution limit)

**Integration approach.**
- For each geocoded entity in known_entities with physical-asset coordinates, extract monthly nighttime light values from VIIRS composites
- Time-series analysis to identify operational intensity changes
- Convert to consumption signal: assumes baseline consumption is correlated with sustained nighttime lights, with changes in lights signaling operational ramp-up or ramp-down

**Integration complexity:** ~4-6 days for the geospatial pipeline, including GeoTIFF processing, raster extraction at facility coordinates, and time-series storage.

**Confidence weight:** 0.50 for absolute consumption estimates (low — this is an indirect signal). 0.75 for relative changes over time (higher — useful for detecting operational changes).

### 4.5 EITI country reports

**What it provides.** Extractive Industries Transparency Initiative requires participating countries to publish detailed annual reports with company-level production data, government revenue data, and operational disclosures. For energy-relevant countries (Trinidad and Tobago specifically, and to a lesser degree DR, Guyana, Suriname), reports include fuel consumption, energy expenditure, and operational details for major extractive companies.

**Primary source:**
- EITI International (eiti.org) — global standard
- Country implementation websites for participating Caribbean basin countries:
  - Trinidad and Tobago EITI (tteiti.org.tt) — strong, includes detailed energy company financials
  - Suriname EITI — moderate, gold and oil sector
  - Guyana EITI — emerging, oil sector focus
  - Dominican Republic EITI — mining sector
  - Mexico, Colombia, Peru — broader Latin American context

**Integration approach.**
- Annual scraper for new EITI reports across participating countries
- PDF parsing with LLM-driven extraction for fuel consumption and energy expenditure tables
- Map company names to known_entities

**Integration complexity:** ~3-4 days for a parsing pipeline.

**Confidence weight:** 0.80 for directly disclosed company-level fuel consumption (rare but high-quality), 0.65 for derived from financial data.

---

## 5. The source universe — Tier B (medium priority)

### 5.1 EU EPRTR + US EPA TRI/GHGRP facility-level emissions

**What it provides.** Facility-level pollutant and GHG emissions reporting in EU and US. Direct emissions data convertible to fuel consumption via intensity factors.

**Primary sources:**
- EU EPRTR (industry.eea.europa.eu) — every facility above threshold reports detailed emissions data
- US EPA TRI (epa.gov/toxics-release-inventory) — toxic release inventory
- US EPA GHGRP (epa.gov/ghgreporting) — greenhouse gas reporting program, includes fuel combustion data
- US EPA Envirofacts — combined database

**Caribbean coverage:**
- Direct: Puerto Rico, USVI (US EPA jurisdiction)
- Indirect: parent companies of Caribbean operations may disclose globally aggregated data
- US/EU operations of multinationals with Caribbean exposure (validates parent-company-wide intensity factors)

**Integration approach.** Direct API or download where available, scraper otherwise. ~3-4 days.

**Confidence weight:** 0.85 for direct facility data.

### 5.2 Customs primary sources by country

**What it provides.** Importer-level data for some Caribbean basin countries that publish primary customs data, equivalent to what Datamyne / Panjiva sell in aggregated form.

**Primary sources:**
- Jamaica Customs Agency (jamaicacustoms.gov.jm) — monthly importer-level data for some HS codes
- TT Customs — limited public disclosure but accessible via OIR
- DR Dirección General de Aduanas (aduanas.gob.do) — monthly statistics
- Brazil ComexStat (comexstat.mdic.gov.br) — comprehensive free trade data
- Colombia DIAN — relatively open data
- Mexico SAT — customs statistics
- Argentina INDEC — trade statistics
- Peru SUNAT — open trade data
- Chile Servicio Nacional de Aduanas — open
- US ITC DataWeb (dataweb.usitc.gov) — US imports only
- UN Comtrade — country-aggregate but free and comprehensive

**Coverage:** Fragmented. Strong for Brazil, Colombia, Chile, Peru. Moderate for Jamaica, DR, Mexico. Weak for the smaller Caribbean economies.

**Integration approach.** Country-by-country scrapers for the highest-priority jurisdictions. ~5-7 days for a Caribbean basin scraper covering Jamaica + DR + T&T + Colombia + Brazil.

**Confidence weight:** 0.75 for importer-level data, 0.55 for country-aggregate data.

### 5.3 Multilateral development bank project disclosures

**What it provides.** When MDBs finance industrial or energy projects, project disclosures include 20-25 year operational projections with fuel consumption, generation, and economic impact data. Model-validated by financing institution.

**Primary sources:**
- IDB project pipeline (iadb.org/en/projects)
- World Bank project portal (projects.worldbank.org)
- IFC project disclosures (disclosures.ifc.org)
- Caribbean Development Bank (caribank.org)
- EIB project disclosures
- CAF (Andean Development Corporation)

**Integration approach.** Quarterly scraper across IDB, World Bank, IFC, CDB. ~3-4 days for working pipeline.

**Confidence weight:** 0.75 for projections (forward-looking, model-derived).

### 5.4 Power sector primary sources

**What it provides.** Capacity, generation, and fuel consumption data for Caribbean utilities and IPPs.

**Primary sources:**
- EIA International Energy Statistics (eia.gov/international)
- IEA data services free tier
- Country grid operators direct:
  - Jamaica Public Service (jpsco.com) — annual reports
  - Office of Utilities Regulation Jamaica (our.org.jm) — regulatory filings
  - T&T Regulated Industries Commission (ric.org.tt)
  - DR Superintendencia de Electricidad — IPP filings
  - Curaçao Aqualectra
  - Barbados Light & Power via parent Emera regulatory filings
- World Bank Energy Data
- IRENA Statistics Database
- Global Energy Monitor (already partial coverage)

**Integration approach.** Cross-reference GEM capacity data with grid operator actual generation data with EIA/IEA country totals. ~5-7 days for comprehensive integration.

**Confidence weight:** 0.85 for utility-disclosed generation data, 0.70 for derived consumption estimates.

### 5.5 Climate TRACE facility-level emissions

**What it provides.** Facility-level emissions estimates derived from satellite + machine learning. Free, model-derived, includes Caribbean industrial facilities.

**Primary source:**
- Climate TRACE (climatetrace.org) — open data, downloadable
- Updated annually
- Coverage: facility-level for major industrial sources globally

**Integration approach.** Annual download, map facility identifiers to known_entities. ~2-3 days.

**Confidence weight:** 0.55 (model-derived, useful as triangulation, not as primary source).

---

## 6. The source universe — Tier C (specialized, lower priority)

### 6.1 Aviation-specific free sources
- ADS-B Exchange (adsbexchange.com) — free unfiltered ADS-B
- OpenSky Network (opensky-network.org) — academic ADS-B
- ICAO statistical data free tier
- Country aviation authorities (Caribbean civil aviation authorities)
- Airport authorities directly (Sangster, NMIA, Piarco)
- Combined approach: ADS-B + standard kg/flight by aircraft type = aviation fuel demand by airport

### 6.2 Tourism and cruise specific
- CTO Caribbean Tourism Organization (caribbeantourism.com)
- Country tourism ministries
- CLIA (cruising.org) — partial free tier
- Cruise line public schedules — aggregate to derive bunker demand by port
- Aggregate cruise fleet schedules + standard fuel consumption per port-day

### 6.3 Subsidy and concession primary sources
- IMF Article IV consultations — country fuel subsidy disclosures
- IEA Fossil Fuel Subsidy Database (iea.org/data-and-statistics)
- Country fuel subsidy ministry data (Jamaica PCJ, DR Hacienda, T&T Energy)
- OECD Inventory of Support Measures for Fossil Fuels

### 6.4 Environmental compliance and EIA documents
- Country environmental agencies: Jamaica NEPA, T&T EMA, DR Ministerio Ambiente, Brazil IBAMA
- EIA/EIS documents — every major project requires environmental impact assessment with fuel consumption disclosure
- Operational permit modifications

### 6.5 Patent and trademark filings (forward indicator only)
- WIPO Global Brand Database
- USPTO trademark and patent search
- Country IP offices
- Forward indicator of operational footprint changes (not consumption itself)

### 6.6 Sentinel satellite analysis
- Sentinel-2 optical imagery (Copernicus) — facility-level operations
- Sentinel-1 SAR — vehicle/equipment movement at facilities
- MODIS thermal anomalies (NASA FIRMS) — refinery flares, process heat
- Heavy lift but high-quality signal at facility level

---

## 7. Recommended priority sequencing for the v2 cycle

If the v2 cycle is 4-6 weeks of work, the recommended sequence:

**Cycle weeks 1-2:**
- Schema implementation (`fuel_consumption_signals`, `fuel_intensity_factors`, `buyer_consumption_estimate`)
- Initial seed of `fuel_intensity_factors` with the 10-15 highest-priority intensity values
- Source #1 integration: **EU MRV emissions database** (highest signal-to-effort ratio)

**Cycle weeks 3-4:**
- Source #2 integration: **NI 43-101 mining technical reports** (multi-year forward projections for mining buyers)
- Source #3 integration: **Bond prospectus mining** (Luxembourg + Bermuda + EMMA + EDGAR)

**Cycle weeks 5-6:**
- Source #4 integration: **EITI country reports** (annual cycle, lower frequency)
- Source #5 integration: **VIIRS Nighttime Lights** (geospatial pipeline)
- Computed view validation against external estimates (EIA country totals, etc.)

**Post-cycle:**
- Tier B sources added incrementally based on commercial validation of the v2 signals
- Tier C sources reserved for specific commercial use cases that justify the effort

---

## 8. What to do tonight

The brief above is a 4-6 week v2 cycle plan. Tonight is one evening. The realistic scope is:

**Option 1 — Read and select.** Read through the source universe, evaluate which 3-5 sources you'd actually integrate first based on commercial use cases you have in mind, and document the selection in this brief. Ship the updated brief tomorrow as the v2 implementation plan.

**Option 2 — Schema spike.** Implement the `fuel_consumption_signals`, `fuel_intensity_factors`, and `buyer_consumption_estimate` schema as a foundation PR, with the 10-15 intensity factor seed values. Sets up the next several weeks of source integration without committing to specific sources tonight.

**Option 3 — Single-source spike.** Pick the EU MRV integration (highest signal-to-effort ratio) and ship it tonight. ~2-3 hours of focused work for a working integration that adds verified marine fuel consumption signals to the existing buyer rolodex.

**Recommended.** Option 2 plus a partial Option 3. Schema implementation is foundational, takes 60-90 minutes, and unblocks the next several integrations. EU MRV download and basic integration is another 60-90 minutes. By end of evening, the foundation is in place and one high-quality source is integrated. Subsequent sources slot into the established schema without architectural rework.

If energy permits, extending into Option 1 (review and select the next 4 sources to ship over the following weeks) closes out the evening with a clear forward plan.

---

## 9. What this brief deliberately doesn't include

- Source-specific scraper implementation code (each source warrants its own implementation PR)
- Detailed entity-to-source mapping for the Caribbean buyer rolodex (this happens during integration, not during planning)
- Extraction prompt engineering for LLM-driven PDF parsing (per-source as needed)
- Cross-source conflict resolution logic beyond the basic weighted average (refinement comes after multiple sources are integrated and conflict patterns emerge)
- Commercial validation cycle structure (separate brief if v2 signals see real commercial use)
- Paid-source comparisons or fallback paths (out of scope per constraint)

---

End of brief.
