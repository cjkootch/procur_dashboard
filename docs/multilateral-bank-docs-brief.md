# Multilateral Development Bank (MDB) Project Documents — Named Caribbean + LATAM Contractors via LLM-Driven Project-Document Mining

**Status:** spec, partial-implementation (Day 1 lands with this brief)
**Owner:** Cole
**Last updated:** 2026-05-12
**Repo:** `cjkootch/procur_dashboard`
**Companion to:** `docs/gain-extraction-brief.md` (sibling brief — same engineering pattern, complementary commodity coverage: GAIN names food/ag importers, this names infrastructure / energy / commodity contractors), `docs/fas-opendata-brief.md`, `docs/buyer-intelligence-v2-free-sources-brief.md`, `docs/strategic-vision.md`

This brief specifies how to ingest project documents from the four multilateral development banks that fund Caribbean / LATAM infrastructure, energy, and commodity work — Inter-American Development Bank (IDB), Caribbean Development Bank (CDB), World Bank, and International Finance Corporation (IFC) — into procur and extract the named contractors, suppliers, borrowers, and technical advisors that the banks identify in their project reports. Procurement notices and project appraisals already name the key players; this brief turns that human-curated intelligence into structured rolodex data at zero ongoing data cost.

Result: a programmatically maintained rolodex of named Caribbean / LATAM **infrastructure + energy + commodity** counterparties, pre-classified by sector + role + contract value, with MDB-published assessment context attached as confidence-weighted signal. **Complements `gain-extraction-brief.md`**: GAIN covers food/ag importers (USDA's domain); MDBs cover everything that gets debt-financed (energy projects, port upgrades, water utilities, agricultural processing facilities, sovereign procurement). The two together close out Caribbean / LATAM **state-adjacent commercial counterparties** at the same engineering shape.

Scope: 4 scrapers (one per bank), 1 LLM extraction pipeline reusing the GAIN-extraction stack (`@procur/ai/gain-extraction/parser.ts` + `extractor.ts`), 1 schema migration, 1 quarterly Trigger.dev cron per bank, 2 chat tools, and 1 intelligence surface (`/intelligence/mdb-contractors`). Estimated effort: **5–7 days** across all four banks (Day 1 lands IDB; subsequent days add the others). LLM extraction cost ~$20-40 one-time backfill (with Haiku triage + Batch API per the gain cost-reduction levers), ~$3-5 per quarter ongoing.

---

## 1. Why this brief exists

The four banks fund the lion's share of Caribbean / LATAM infrastructure + energy + utilities + agricultural processing work. Every funded project produces public project-appraisal documents + procurement notices + contract-award records that name:

- **Borrowers** — sovereign entities, state-owned enterprises, private-sector firms receiving the financing
- **Contractors** — civil engineering / construction / IT / financial-advisory firms winning the procurement
- **Suppliers** — equipment / materials / commodity providers
- **Technical advisors** — engineering / environmental / financial consulting firms

For Caribbean basin specifically:
- **IDB:** ~$15B/yr lending across LATAM. Strongest coverage for Mexico, Colombia, DR, Jamaica, T&T, Guyana. Public API + structured project archive.
- **CDB:** ~$700M/yr lending; CARICOM-only mandate. Covers small islands (Bahamas, Barbados, Antigua, Grenada) that the larger banks don't reach.
- **World Bank:** Massive global coverage; filtered to Caribbean / LATAM seed list returns ~150 active projects across the seed countries.
- **IFC:** Private-sector lending. **Highest signal-to-noise** for commercial counterparties (private companies vs. governments).

Three operational gaps this closes:

- **Coverage where OCDS doesn't reach.** Procur's OCDS ingest (per `pricing-analytics-brief.md`) covers 10 publishers — Mexico, Colombia, Paraguay, Honduras, plus six others. The seed-list countries WITHOUT OCDS publishers (Cuba, Bahamas, Haiti) get NO sovereign-procurement intelligence today. Multilateral bank docs DO cover these countries via their project archives.

- **Sector breadth.** GAIN extraction names ag/food importers exclusively. MDBs name **everything else** — refineries, power plants, ports, water utilities, transmission lines, processing facilities. For a commodities trading platform, the energy + infrastructure counterparties matter as much as the ag ones.

- **Contract-value provenance.** MDB documents publish USD-denominated contract values for awarded procurements. Procur's `award_price_deltas` materialized view (per `pricing-analytics-brief.md`) wants such structured price data; MDB-sourced contract values feed that directly with high-confidence regulatory provenance.

---

## 2. Scope and non-scope

**In scope:**
- IDB project archive (`api.iadb.org/v1/projects` + project-document downloads)
- CDB contract awards (HTML scrape at `caribank.org/work-with-us/procurement/contract-awards`)
- World Bank project archive (`search.worldbank.org/api/v3/projects` filtered to seed countries)
- IFC project documents (`ifc.org/projects` + bulk PDF download)
- LLM extraction pipeline shared with GAIN — same `parser.ts` + `extractor.ts` shape with MDB-specific schema
- Cross-reference layer: contracts / awards from MDB data joined to `known_entities` and `external_suppliers`
- 2 chat tools surfacing the integrated MDB graph
- `/intelligence/mdb-contractors` page

**Out of scope:**
- **Real-time loan-tracker integration.** MDBs publish project status updates (active / closed / cancelled) but the workflow is monthly-cadence at most; real-time wouldn't add operator value.
- **Translation infrastructure.** Spanish + English mostly; existing BGE-M3 multilingual embedding layer handles search if needed.
- **Bilateral aid agencies (USAID, JICA, etc.).** Distinct ingestion pattern; defer.
- **Historical archive deeper than 10 years.** Project archives extend back further but coverage thins out; 10-year window is enough for active-counterparty identification.

---

## 3. Data source mechanics

### 3.1 IDB (Inter-American Development Bank)

- **Search API:** `https://api.iadb.org/v1/projects` — JSON; supports country / sector / status / date-range filters. No API key.
- **Document download:** project-record JSON includes `documents[].url` links to PDF appraisal docs, procurement plans, and award notices.
- **Coverage:** All LATAM + Caribbean. ~5K active + closed projects across the seed countries in last 10 years.
- **Cadence:** Project data updated daily; new documents posted on each procurement milestone.
- **Naming convention:** IDB publishes contractor names in raw form ("EMPRESA EJEMPLO S.A. DE C.V."). Entity resolution handles dedup against `known_entities`.

### 3.2 CDB (Caribbean Development Bank)

- **URL:** `https://www.caribank.org/work-with-us/procurement/contract-awards` (HTML list of recent awards) + `https://www.caribank.org/operations/projects` (project search).
- **Format:** HTML for the award list (well-structured tables); project documents are PDF.
- **Coverage:** CARICOM-only. ~150 active projects across Bahamas / Barbados / Antigua / Grenada / Belize / Dominica / Guyana / Jamaica / Suriname / Trinidad + others.
- **Cadence:** Awards posted monthly; project documents on milestone.
- **No API** — HTML scrape required. Polite-crawler at 1 req / 2 sec.

### 3.3 World Bank

- **Search API:** `https://search.worldbank.org/api/v3/projects` — JSON; supports `countryshortname_exact` filter for Caribbean / LATAM seed countries.
- **Document download:** `documents.worldbank.org/curated/...` URLs in the project record.
- **Coverage:** ~150 active projects across seed countries; ~600 closed in last 10y.
- **Cadence:** Updated weekly.
- **Naming convention:** Standardized — borrower / agency / contractor named in structured fields where possible; full text in PDFs.

### 3.4 IFC (International Finance Corporation)

- **URL:** `https://www.ifc.org/projects` (Project Information Portal) — supports country + sector + date filters via UI; underlying API at `ifcndd.ifc.org/api/...`
- **Format:** PDF Project Disclosure documents; **always private-sector recipients** (the IFC's mandate).
- **Coverage:** ~80 active projects across seed countries.
- **Cadence:** Monthly.
- **High signal-to-noise** — every IFC project = named private-sector counterparty (the loan recipient). For commercial-counterparty identification, IFC is the highest-yield bank per document.

---

## 4. LLM extraction pipeline

Reuses the GAIN extraction stack directly. The MDB project documents follow a similar shape to GAIN reports — section-structured PDFs with named entities embedded in narrative. The same `@procur/ai/gain-extraction/parser.ts` (header-heuristic section splitter) and `extractor.ts` (per-section Sonnet call with structured output) work with MDB-specific candidate-section patterns + Zod schema.

Candidate section patterns (MDB-specific):
- "Procurement Plan" / "Procurement Notice" / "Contract Award"
- "Implementing Agency" / "Executing Agency"
- "Contractors" / "Suppliers" / "Consultants"
- "Project Beneficiaries" / "Borrowers"
- Per-component / per-package narrative discussions

Discard patterns (same as GAIN):
- "Disclosure Statement" / "Safeguards" / "Environmental Impact Assessment"
- "Annex" / "Appendix" / "References"
- "Contact Information"

**Cost levers (already shipped in PR #644 for GAIN; apply identically here):**
- `MDB_EXTRACT_TRIAGE=1` — Haiku pre-filter, ~30-40% fewer Sonnet calls
- `MDB_EXTRACT_BATCH=1` — Anthropic Batch API, 50% off all Sonnet calls
- Combined: ~70% of baseline LLM cost

Per-bank backfill estimates (with both levers stacked):
- IDB ~$8-12, CDB ~$2-3, World Bank ~$8-12, IFC ~$4-6
- Total backfill ~$25-35 (down from ~$80-100 baseline)
- Quarterly delta total ~$5-8

---

## 5. Schema additions

Two additive tables, mirroring `gain_reports` + `gain_importer_mentions` shape.

### 5.1 `mdb_projects`

```sql
CREATE TABLE mdb_projects (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bank            TEXT NOT NULL,             -- 'idb' | 'cdb' | 'worldbank' | 'ifc'
  external_id     TEXT NOT NULL,             -- bank's internal project identifier
  country_code    TEXT NOT NULL,             -- ISO-2 of borrower country
  project_name    TEXT NOT NULL,
  sector          TEXT,                      -- bank-published sector classification
  status          TEXT,                      -- 'active' | 'closed' | 'cancelled' | 'pipeline'
  approval_date   DATE,
  closing_date    DATE,
  total_amount_usd NUMERIC(20, 2),
  source_url      TEXT NOT NULL,
  source_doc_url  TEXT,                      -- primary appraisal document URL
  pdf_blob_url    TEXT,                      -- Vercel Blob cached copy when avail
  pdf_sha256      TEXT,
  pdf_page_count  INTEGER,
  extraction_status TEXT NOT NULL DEFAULT 'pending',
  extraction_attempted_at TIMESTAMP,
  extraction_completed_at TIMESTAMP,
  extraction_error TEXT,
  raw_metadata    JSONB,
  discovered_at   TIMESTAMP NOT NULL DEFAULT NOW(),
  created_at      TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE (bank, external_id)
);
CREATE INDEX idx_mdb_projects_country_status ON mdb_projects (country_code, status, approval_date DESC);
CREATE INDEX idx_mdb_projects_pending ON mdb_projects (extraction_status, discovered_at) WHERE extraction_status = 'pending';
```

### 5.2 `mdb_entity_mentions`

```sql
CREATE TABLE mdb_entity_mentions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      UUID NOT NULL REFERENCES mdb_projects(id) ON DELETE CASCADE,
  company_name    TEXT NOT NULL,
  company_name_normalized TEXT NOT NULL,
  roles           TEXT[] NOT NULL,           -- ['borrower', 'contractor', 'supplier', 'consultant', ...]
  sector          TEXT,                      -- 'energy', 'infrastructure', 'water', 'transport', 'agriculture', etc.
  contract_value_usd NUMERIC(20, 2),         -- when published
  context_excerpt TEXT NOT NULL,
  source_section  TEXT,
  source_page     INTEGER,
  extraction_confidence NUMERIC(3, 2) NOT NULL CHECK (extraction_confidence BETWEEN 0 AND 1),
  validator_grade TEXT,
  resolved_entity_id TEXT,
  resolution_confidence NUMERIC(3, 2),
  resolution_method TEXT,
  extracted_at    TIMESTAMP NOT NULL DEFAULT NOW(),
  created_at      TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_mdb_mentions_project ON mdb_entity_mentions (project_id);
CREATE INDEX idx_mdb_mentions_company_normalized ON mdb_entity_mentions (company_name_normalized);
CREATE INDEX idx_mdb_mentions_entity ON mdb_entity_mentions (resolved_entity_id) WHERE resolved_entity_id IS NOT NULL;
```

---

## 6. Service layer architecture

Per-bank ingest script at `packages/db/src/ingest-mdb-{bank}.ts`. Each follows the same shape (search API → filter to seed countries → fetch documents → store metadata → optional Blob upload). LLM extraction lives in `@procur/ai`, reusing `gain-extraction/parser.ts` + `extractor.ts` with an MDB-specific Zod schema + prompt.

```
[Scraper, per bank]      — discover projects via search API
   ↓
[Document download]      — fetch PDF, cache in Vercel Blob, hash
   ↓
[Parser]                 — shared with GAIN (gain-extraction/parser.ts)
   ↓
[Extractor]              — shared shape; MDB-specific Zod schema + prompt
   ↓
[Deduper]                — within-project + cross-project dedup
   ↓
[Persistence]            — mdb_entity_mentions
   ↓
[Resolver]               — match to known_entities (Day 4 work)
```

---

## 7. Integration surfaces

### 7.1 Chat tools

- `lookup_mdb_contractors({ country?, sector?, bank?, role? })` — ranked list of contractors with project count + total contract value + sectors.
- `analyze_mdb_country({ country, lookbackYears? })` — country-level summary of MDB-funded projects + top contractors + sector breakdown.

### 7.2 Existing chat tools enriched

- `lookup_known_entities` auto-includes MDB project count + contract-value totals when the entity has resolved MDB mentions.
- `analyze_supplier` adds an "MDB-funded work" section.

### 7.3 Intelligence surface

`/intelligence/mdb-contractors` — graph-first view, filter by bank / sector / country / project status. Each card links to the entity profile.

---

## 8. Operational sequencing

**Day 1 — IDB foundation (this PR):**
- Migration: `mdb_projects` + `mdb_entity_mentions`
- `ingest-mdb-idb.ts` — IDB API + PDF caching
- Smoke against 5 active Caribbean projects

**Day 2 — World Bank + CDB:**
- `ingest-mdb-worldbank.ts` (similar API shape to IDB)
- `ingest-mdb-cdb.ts` (HTML scrape — heterogeneous)

**Day 3 — IFC + extraction pipeline:**
- `ingest-mdb-ifc.ts`
- MDB-specific Zod schema + prompt at `packages/ai/src/mdb-extraction/`
- Reuse parser + extractor with MDB candidate-section patterns

**Day 4 — entity resolution + validator (shared with GAIN Day 4 work):**

**Day 5 — chat tools + intelligence surface:**

---

## 9. Cost and operational accounting

- **Data cost: $0.** All sources are free.
- **LLM cost with cost levers stacked** (per §4): ~$25-35 backfill, ~$5-8/quarter.
- **Storage:** ~500 cached PDFs at ~3MB avg = ~1.5 GB in Vercel Blob.
- **Bandwidth:** quarterly delta ~50 documents × 3MB = ~150 MB.
- **Maintenance:** MDB portals are stable; expected scraper maintenance ~1 day/year per bank.

---

## 10. What this brief deliberately doesn't include

- **Loan-level financial covenant extraction.** Possible but high false-positive risk and lower commercial-counterparty signal value than the contractor-level work. Defer.
- **Bilateral aid agencies.** Different shape; separate brief if/when value materializes.
- **Per-package procurement timeline tracking.** Useful but adds ~2x storage; not in operator value chain today.

---

## 11. Success metrics

- **Coverage:** ≥80% of IDB + IFC active projects across the seed countries land in `mdb_projects` after backfill.
- **Resolution density:** ≥40% of `mdb_entity_mentions` rows resolve to `known_entities` (auto-create stubs for the rest).
- **Cross-source confirmation:** ≥10 entities appear in BOTH `gain_importer_mentions` AND `mdb_entity_mentions` — high-confidence cross-validation that the extraction pipeline produces consistent canonical names across pipelines.

---

## Open decisions before Day 2

1. **IFC project document access.** `ifc.org/projects` UI is fine; the underlying API may need a specific request shape — validate during IDB Day 1 work.
2. **CDB HTML scraping policy.** Polite-crawler at 1 req / 2 sec is the default; verify CDB's robots.txt before deploying.
3. **Cross-source dedup at extraction time.** When a contractor appears in both GAIN AND MDB extraction, should the two pipelines emit separate rows (current design) or share via the `extracted_entities` polymorphic table? Per §11 success metric, separate-but-cross-validated is the chosen design.
