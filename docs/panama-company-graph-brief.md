# Panama Company Intelligence — Multi-Source Free-Data Importer + Service-Provider Graph

**Status:** spec, not yet implemented
**Owner:** Cole
**Last updated:** 2026-05-12
**Repo:** `cjkootch/procur_dashboard`
**Companion to:** `docs/fas-opendata-brief.md` (the FAS country-level macro layer this complements with company-level depth for Panama specifically), `docs/gain-extraction-brief.md` (sibling brief — names importers via USDA narrative reports across the seed list; this one targets one country deeply via structured government data), `docs/buyer-intelligence-v2-free-sources-brief.md` (the broader free-source pattern this slots into), `docs/caribbean-fuel-buyer-brief.md` Phase 3 (the contact-enrichment work this gives a structural foundation to), `docs/supplier-graph-brief.md`, `docs/strategic-vision.md`

This brief specifies how to build a comprehensive Panama company graph from **free, structured government sources**. The result is a programmatically maintained rolodex of named Panama entities — importers, service providers, contractors, government counterparties — with their economic activity (contracts won, vessels operated, regulatory notices) attached as confidence-weighted signal.

Result: when FAS reports *"the US shipped X bbl of refined fuel to Panama this week"*, procur can drill down to *"Empresa Y handled the import via Manzanillo International Terminal, has won $Z in PanamaCompra fuel contracts, owns vessel callsign ABC123 that transited the Canal northbound on 2026-05-08"*. Each layer is partial; the **combination** is operator-grade.

Scope: **5 scrapers** (PanamaCompra OCDS, Contraloría trade statistics, ACP cargo transit, Registro Público entity registry, Gaceta Oficial regulatory notices) **+ 1 entity-resolution pipeline** + **1 schema migration** + **2 chat tools** + **1 intelligence surface** (`/intelligence/panama-graph`). Estimated effort: **6–8 days**. Zero per-call API cost; all sources are free government endpoints. LLM extraction cost for Gaceta Oficial regulatory-notice parsing ~$10-20 one-time backfill, ~$2-3 per quarter ongoing.

---

## 1. Why this brief exists

Panama is the Caribbean transhipment hub. **~90% of Caribbean container traffic touches Colón.** Most regional fuel cargoes, food shipments, and consumer goods move through Panama before fanning out to the smaller islands. The FAS Open Data ingest (PRs #634/#636/#639) tells procur *that* these flows exist; it doesn't say *who* is on the receiving end.

Three operational gaps this closes:

- **Buyer identification for Panama-destination cargoes.** FAS ESR says "US exporters committed 50,000 MT of corn to Panama in Q1 2026." Today procur cannot name the consignee. After this brief: PanamaCompra contracts + Contraloría top-importer lists + ACP transit logs cross-reference to a short list of likely consignees per cargo.
- **Service-provider mapping for downstream Caribbean trades.** Many regional fuel distributors and food traders are Panama-domiciled even when they sell into Jamaica / DR / Trinidad. Without a Panama company graph, procur misses the structural intermediary.
- **Buyer-side procurement signal.** PanamaCompra is Panama's OCDS publisher (procur already ingests 10 OCDS publishers per `pricing-analytics-brief.md`; Panama is the obvious 11th and is **free**). Every fuel / food / services tender awarded by Panama state entities surfaces a named counterparty.

Per-shipment customs declarations (the ImportGenius / Panjiva / Datamyne dataset) are **NOT** publicly published by Panama. The honest scope of this brief: combine the free structured sources into a graph that delivers ~60-70% of the value of paid data, with paid escalation as an explicit follow-up if the operator hits a wall.

---

## 2. Scope and non-scope

**In scope:**
- PanamaCompra OCDS ingest (procurement awards, contract values, named winners) — Panama is the 11th OCDS publisher procur tracks.
- Contraloría General de la República (INEC) trade statistics scrape — monthly aggregate by HS chapter, top importer lists where published.
- Autoridad del Canal de Panamá (ACP) monthly cargo transit data — vessel-level, monthly, names vessels not consignees.
- Registro Público de Panamá entity registry — full-text search for entity name → public record (officers, registered address, status). Used at resolver time, not bulk ingested.
- Gaceta Oficial regulatory-notice scraper — LLM-extracted entity mentions from official-gazette notices (company formation, dissolution, board changes, government contracts, licensing).
- Cross-reference layer: vessels from ACP transit data against procur's existing `vessels` table; companies against `known_entities` and `external_suppliers`.
- Chat tools surfacing the integrated graph.
- One intelligence surface at `/intelligence/panama-graph`.

**Out of scope:**
- **Per-shipment customs declarations.** These are not published. Paid data (ImportGenius / Panjiva / Datamyne) is the path if the operator needs them; this brief does not propose buying them.
- **Real-time vessel positions in Panama waters.** Already covered by `intelligence-layers-brief.md` Layer 1 (AISStream ingest).
- **Phytosanitary import permits.** Panama publishes these but coverage is thinner than DR / Costa Rica; they're a candidate for a sibling brief covering Caribbean sanitary registries.
- **Translation infrastructure.** Sources are Spanish-language; procur's existing BGE-M3 multilingual embedding layer (per `procur-ml-layer-brief.md`) handles search; entity names stay verbatim.
- **Backfill of historical OCDS contracts older than 5 years.** Procur's existing OCDS ingest convention is 5-year-back-window per publisher; same applies here.

---

## 3. Data source mechanics

### 3.1 PanamaCompra (OCDS)

- **URL:** `https://www.panamacompra.gob.pa/ProcesosV3/` (web UI); OCDS export at `https://standard.open-contracting.org/registry/panama/` (link to Panama's OCDS feed).
- **Format:** OCDS JSON, conforming to the same schema procur already ingests for the existing 10 publishers.
- **Coverage:** All Panama state procurement above the per-entity threshold (currently 50,000 PAB ≈ 50,000 USD). Tens of thousands of awards per year across fuel, food, infrastructure, IT, etc.
- **Cadence:** Updated daily. Bulk historical exports refreshed monthly.
- **What we extract:** `tender.id`, `awards[].suppliers[].name`, `awards[].value`, `tender.classification.id` (CPV/HS), `buyer.name`, `contract.dateSigned`.
- **Naming convention:** PanamaCompra publishes supplier names in raw form ("EMPRESA EJEMPLO, S.A."). Entity resolution handles dedup against existing rolodex.

### 3.2 Contraloría General de la República (INEC)

- **URL:** `https://www.inec.gob.pa/publicaciones/` (statistical publications portal).
- **Format:** PDF + Excel. Monthly "Boletín de Comercio Exterior" — country-level trade by HS chapter.
- **Coverage:** Monthly import / export totals by HS2 (chapter), HS4, sometimes HS6. **Top importers list** for selected commodity groups (fuel, vehicles, machinery, electronics) is published quarterly in narrative reports.
- **Cadence:** Monthly aggregate; quarterly narrative.
- **What we extract:** Aggregate country totals (already-redundant with FAS / UN ComTrade), AND the **top-importers-by-category** lists where they appear — these are the company-level signal.
- **Caveat:** The top-importer lists are 5-20 entries per category, not exhaustive. Treat as confidence-weighted seed: companies on this list are confirmed major importers in their category.

### 3.3 Autoridad del Canal de Panamá (ACP)

- **URL:** `https://pancanal.com/transit-statistics/` (transit stats); `https://pancanal.com/en/maritime-services/transit-statistics-and-cargo-data/` (cargo).
- **Format:** PDF + downloadable Excel. Monthly + annual.
- **Coverage:** Every commercial vessel transiting the Canal — vessel name, type, flag, tonnage, origin port, destination port, cargo class, transit date. **~13,000 transits per year.** Names vessels, NOT consignees.
- **Cadence:** Monthly publication, ~30-day lag.
- **What we extract:** Vessel-level transit records joined to `vessels` table by IMO / callsign. Origin / destination ports + cargo class enrich the existing vessel intelligence layer with Canal-specific context.
- **Why this matters even without consignee names:** crossed with AISStream port-call data (already ingested), procur learns *"this vessel transited the Canal northbound on 2026-05-08, then called at Manzanillo Container Terminal, then sailed to Kingston"* — a structural lane signal even without the cargo manifest.

### 3.4 Registro Público de Panamá

- **URL:** `https://www.registro-publico.gob.pa/` (entity-search UI).
- **Format:** Public web UI, **no bulk API**. Per-entity lookup returns: legal name, RUC (tax ID), registered address, officers, status (active / suspended / dissolved), formation date.
- **Coverage:** All Panama-registered legal entities. Lookups by name (fuzzy) or RUC (exact).
- **Cadence:** Real-time on lookup.
- **What we extract:** Used at **entity-resolution time** rather than bulk-ingested. When PanamaCompra / Contraloría / Gaceta Oficial mention "EMPRESA EJEMPLO S.A.", the resolver hits Registro Público to canonicalize: legal name, RUC, address, current status. Result stored in `known_entities.external_keys.panama_ruc`.
- **Rate limit consideration:** Polite-crawler pattern at 1 req / 2 sec to stay below detection threshold; cache aggressively (entity registry data changes monthly at most).

### 3.5 Gaceta Oficial

- **URL:** `https://www.gacetaoficial.gob.pa/` (official gazette).
- **Format:** PDF (daily publication, ~50-200 pages per issue).
- **Coverage:** All official acts — laws, decrees, judicial rulings, **company formations / dissolutions / board changes**, **government contract announcements**, regulatory licensing.
- **Cadence:** Daily PDF publication.
- **What we extract:** LLM-driven extraction of named-entity mentions from notice text. Uses the same pattern as `gain-extraction-brief.md` §4 — `unpdf` + Anthropic Sonnet, GLiNER for entity tagging (per CLAUDE.md's existing `extracted_entities` polymorphic table).
- **Signal quality:** Company formations and contract announcements are explicit; board changes and licensing notices add officer-level signal that complements Apollo people enrichment for Panama-specific entities.

---

## 4. Pipeline architecture

```
                 ┌─────────────────────────────────────────┐
                 │       Source Ingestion (5 scrapers)     │
                 ├─────────────────────────────────────────┤
   OCDS feed  ──▶│  ingest-panamacompra-ocds              │──▶ awards / contracts
                 │  ingest-panama-contraloria             │──▶ top-importer lists
                 │  ingest-panama-acp-transit             │──▶ vessel transits
                 │  ingest-panama-gaceta                  │──▶ regulatory notices (LLM)
                 │  resolve-panama-rput                   │──▶ entity registry (on-demand)
                 └─────────────────────────────────────────┘
                              │
                              ▼
                 ┌─────────────────────────────────────────┐
                 │      Entity Resolution Layer            │
                 ├─────────────────────────────────────────┤
                 │  • Fuzzy match against known_entities    │
                 │  • RUC-based exact match via Registro    │
                 │  • GLiNER NER + extracted_entities       │
                 │  • Confidence-weighted dedup             │
                 └─────────────────────────────────────────┘
                              │
                              ▼
                 ┌─────────────────────────────────────────┐
                 │      Integrated Graph                   │
                 ├─────────────────────────────────────────┤
                 │  known_entities (canonical)             │
                 │  + panama_entity_signals (per-source)   │
                 │  + cross-refs to vessels / contracts /  │
                 │    customs_imports / fuel_consumption   │
                 └─────────────────────────────────────────┘
                              │
                              ▼
                 ┌─────────────────────────────────────────┐
                 │      Operator Surfaces                  │
                 ├─────────────────────────────────────────┤
                 │  • Chat: lookup_panama_entity           │
                 │  • Chat: analyze_panama_market          │
                 │  • UI:   /intelligence/panama-graph     │
                 │  • Existing: lookup_known_entities,     │
                 │    analyze_supplier (now richer for PA) │
                 └─────────────────────────────────────────┘
```

The 5 scrapers run on independent cadences (OCDS daily, Contraloría / ACP monthly, Gaceta daily, Registro on-demand). The resolver runs as a follow-on stage after each ingest to canonicalize new mentions against `known_entities`.

---

## 5. Schema additions

### 5.1 `panama_entity_signals` (new)

One row per (entity, source, signal_kind) observation. Polymorphic `entity_slug` text column accepts `known_entities.slug` OR `external_suppliers.id` (mirrors `fuel_consumption_signals` + `supplier_approvals` convention).

```sql
CREATE TABLE panama_entity_signals (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_slug     TEXT NOT NULL,
  source          TEXT NOT NULL,    -- 'panamacompra' | 'contraloria' | 'acp' | 'gaceta' | 'rput'
  signal_kind     TEXT NOT NULL,    -- 'contract_award' | 'top_importer_list' | 'vessel_transit' |
                                    -- 'company_formation' | 'board_change' | 'licensing_notice' |
                                    -- 'registry_record'
  observed_at     DATE NOT NULL,
  coverage_period TEXT,             -- e.g. '2026-Q1', '2026-04', month-of-publication

  -- Source-specific payload (HS code on imports, contract value on awards,
  -- vessel IMO on transits, RUC on registry records, etc.)
  source_ref      TEXT,             -- canonical source identifier (contract id, IMO, RUC)
  payload         JSONB NOT NULL,

  -- Quantitative columns where applicable (NULL for narrative signals).
  value_usd       NUMERIC(20, 2),

  confidence      NUMERIC(3, 2) NOT NULL DEFAULT 0.70 CHECK (confidence BETWEEN 0 AND 1),

  raw_payload     JSONB,
  ingested_at     TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMP NOT NULL DEFAULT NOW(),

  UNIQUE (source, source_ref, signal_kind, entity_slug)
);

CREATE INDEX panama_entity_signals_entity_idx ON panama_entity_signals(entity_slug);
CREATE INDEX panama_entity_signals_source_kind_idx ON panama_entity_signals(source, signal_kind, observed_at DESC);
```

### 5.2 `known_entities.external_keys` (extension via existing JSONB column)

Add `panama_ruc` key for Panama-registered entities. No migration needed (column is JSONB); resolver writes when Registro Público lookup succeeds.

### 5.3 ACP transit data joins `vessels` table

ACP transit records reference vessels by IMO. The existing `vessels` table from `intelligence-layers-brief.md` is the canonical join target. New ACP-specific columns added via migration:

```sql
ALTER TABLE port_calls ADD COLUMN IF NOT EXISTS panama_canal_transit BOOLEAN DEFAULT FALSE;
ALTER TABLE port_calls ADD COLUMN IF NOT EXISTS panama_canal_direction TEXT;
                            --  'northbound' | 'southbound' | NULL
```

ACP ingest writes synthetic `port_calls` rows (port=PA-Canal) so the existing vessel-activity UI surfaces Canal context without a parallel table.

---

## 6. Service layer architecture

Each scraper is a standalone Node script under `packages/db/src/` following the existing FAS / OCDS pattern. Trigger.dev v4 cron schedules (gated on the v3→v4 migration per CLAUDE.md; until then, run via `pnpm` script):

- `ingest-panamacompra-ocds.ts` — daily, 24h lookback window
- `ingest-panama-contraloria.ts` — monthly (1st of month), 90-day lookback
- `ingest-panama-acp-transit.ts` — monthly, 60-day lookback
- `ingest-panama-gaceta.ts` — daily, 24h lookback, LLM extraction stage
- Resolver: `resolve-panama-rput.ts` — on-demand, called from other ingest scripts when a new entity name appears that doesn't match `known_entities`. Hits Registro Público at 1 req / 2 sec.

LLM extraction (Gaceta) lives in `@procur/ai` (mirrors `ingest-bond-prospectus` and `ingest-eiti-report` patterns). Other scrapers are pure DB.

---

## 7. Integration surfaces

### 7.1 Chat tools (in `packages/catalog/src/tools.ts`)

- `lookup_panama_entity({ name?, ruc?, hsActivity? })` — returns the integrated graph for a Panama entity: contracts won, top-importer-list appearances, vessel transits, registry record, recent regulatory notices. Mirrors `analyze_supplier` shape but Panama-specific.
- `analyze_panama_market({ commodityCode?, hsChapter?, segmentKey? })` — given a commodity, returns ranked Panama-based players by signal density (contracts + top-importer mentions + Canal transit volume).

### 7.2 Existing chat tools enriched

- `lookup_known_entities` — auto-includes Panama signal density when the entity is Panama-domiciled.
- `analyze_supplier` — Panama section gets fuller via the new signals table.
- `lookup_fas_un_comtrade_partners({ country: 'PA', ... })` — when partner is `PA`, optionally hydrate top consignee candidates from `panama_entity_signals`.

### 7.3 Intelligence surface

`/intelligence/panama-graph` — a graph-first view: top entities by signal density, filter by HS chapter / vessel class / contract category. Each card links to the existing entity profile at `/entities/[slug]` with a Panama-specific section panel.

---

## 8. Operational sequencing

**Day 1-2 (Foundation):**
- Migration: `panama_entity_signals` table + `port_calls.panama_canal_*` columns.
- `ingest-panamacompra-ocds.ts` (most structured, lowest risk, biggest immediate yield).
- Entity resolver skeleton with fuzzy-match against `known_entities`.

**Day 3-4 (Vessel + statistical):**
- `ingest-panama-acp-transit.ts` (joins existing vessels table).
- `ingest-panama-contraloria.ts` (PDF + Excel parsing; reuse `unpdf`).

**Day 5 (Narrative extraction):**
- `ingest-panama-gaceta.ts` + LLM extraction stage.
- `resolve-panama-rput.ts` (on-demand Registro Público lookups).

**Day 6 (Surfaces):**
- Two new chat tools + system-prompt entry per CLAUDE.md's chat-tool-friction discipline.
- `/intelligence/panama-graph` page.

**Day 7-8 (Polish + validation):**
- Cross-reference shipped FAS data (`lookup_fas_un_comtrade_partners({ country: 'PA' })`) against the new Panama entity graph; manual spot-check 20 top mentions.
- Operator-driven seed correction round.

---

## 9. Cost and operational accounting

- **API costs:** All sources are free government endpoints. Zero per-call cost.
- **LLM costs (Gaceta extraction only):** ~$10-20 one-time backfill (3 years of daily PDFs at Sonnet rates), ~$2-3 per quarter ongoing for incremental daily processing. Use the same prompt-caching pattern as `ingest-bond-prospectus` and `ingest-eiti-report`.
- **Rate limits / polite-crawler discipline:**
  - PanamaCompra OCDS — official feed, no observed rate limit, but cap at 1 req/sec for politeness.
  - Contraloría / ACP — static PDF / Excel downloads; cache locally to avoid re-fetch.
  - Registro Público — 1 req / 2 sec; aggressive in-memory cache during a single ingest run.
  - Gaceta Oficial — 1 PDF per day to download; ingest is sequential.
- **Storage:** Polymorphic signals table; budget ~50K rows in year 1 (10K contracts + 15K transits + 25K narrative mentions).

---

## 10. What this brief deliberately doesn't include

- **Per-shipment customs declarations.** These are the ImportGenius / Panjiva / Datamyne dataset. They EXIST but are not free. Operator can escalate to paid data if the free-source graph hits a wall.
- **Real-time AIS for Panama waters.** Already in scope via `intelligence-layers-brief.md` Layer 1.
- **Phytosanitary / SENASA permits.** Panama's coverage here is thinner than DR / Costa Rica; defer to a sibling brief on Caribbean sanitary registries.
- **Tax filings / SUI / CSS payroll records.** Available via Panama transparency law but request-based, not bulk; not worth the engineering burden today.
- **Translation infrastructure.** Spanish-language source content stays verbatim; the existing BGE-M3 multilingual embedding layer handles search.

---

## 11. Success metrics

- **Coverage:** ≥80% of PanamaCompra fuel + food awards from the last 24 months resolve to a canonical `known_entities` row (new or existing).
- **Cross-source signal density:** ≥30% of Panama entities in the rolodex have ≥2 distinct `panama_entity_signals` source kinds (e.g. contract_award + vessel_transit).
- **Operator validation:** When asked *"who handles US-origin fuel imports into Panama?"* the assistant returns a top-5 named entities list, each with concrete evidence chain (contract, Canal transit, registry record). 30-day audit confirms ≥4 of 5 are real industry players.
- **Compounding effect:** The Panama company graph identifies ≥10 entities that turn out to be sister companies / parent companies / subsidiaries of existing rolodex entities in Jamaica / DR / Trinidad — i.e. structural intermediaries the country-by-country rolodex was missing.

---

## Open decisions before build

These need a Cole-decision before Day 1:

1. **PanamaCompra OCDS endpoint shape.** Is Panama's OCDS feed truly OCDS-conformant, or does it need a custom adapter? Procur's existing OCDS ingest assumes standard shape; one-day spike to validate before committing to "10 OCDS publishers → 11" framing.
2. **ACP transit data licensing.** ACP publishes statistics; verify reuse / republication terms permit ingestion into procur. (Public-domain confidence is high but not pre-verified.)
3. **Gaceta Oficial LLM budget cap.** $20 one-time backfill is the estimate; do we cap at $30 with operator alert, or let it run open?
4. **Registro Público polite-crawler vs. official bulk option.** The registry has an API tier (paid?) — verify whether the operator wants to pay for a faster bulk path or stick with web-scrape at 1 req / 2 sec.
5. **Translation handling.** Source content is Spanish. Do operator-facing chat tool responses translate to English, or quote Spanish verbatim with English commentary? Existing pattern: quote verbatim (per system-prompt's transparency discipline).

---

## Phase 0 sign-off

This brief is in spec form. Before implementation:

- Operator reviews and confirms scope.
- Open decisions above resolved.
- Status flipped in `docs/_status.md` from ✗ to 🟡 (in flight) on Day 1.
