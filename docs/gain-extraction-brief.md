# USDA FAS GAIN Report Extraction — Named Caribbean + LATAM Food Importers via LLM-Driven PDF Mining

**Status:** spec, not yet implemented
**Owner:** Cole
**Last updated:** 2026-05-11
**Repo:** `cjkootch/procur_dashboard`
**Companion to:** `docs/fas-opendata-brief.md` (the FAS macro layer this complements with narrative depth), `docs/mirror-export-side-brief.md` (the supply-side scraper that names origin exporters — this brief names destination importers), `docs/buyer-intelligence-v2-free-sources-brief.md` §4.1 (the bond-prospectus extraction pattern this brief mirrors for GAIN reports), `docs/supplier-graph-brief.md`, `docs/strategic-vision.md`

This brief specifies how to ingest USDA FAS's narrative country reports — published as PDFs under the Global Agricultural Information Network (GAIN) system — into procur and extract the named importing companies, distributors, retailers, and food service operators that USDA's overseas posts identify in their analysis. The reports are written by FAS attachés in country; they already name the key players in each food category in plain English. This brief turns that human-curated intelligence into structured rolodex data with zero ongoing cost.

Result: a programmatically maintained rolodex of named Caribbean / LATAM food importers and distributors, pre-classified by commodity category, with USDA's own narrative assessment attached as confidence-weighted context.

Scope: 1 scraper for the GAIN search/download endpoints, 1 LLM extraction pipeline using existing `@procur/ai` infrastructure, 1 schema table for extracted importer mentions, entity-resolution integration with `known_entities`, 1 quarterly Trigger.dev cron, 2 chat tools, and 1 new intelligence surface (`/intelligence/gain-importers`). Estimated effort: **4–6 days**. Zero per-call API cost on the data side; LLM extraction cost ~$15-30 one-time backfill, ~$3-5 per quarter ongoing.

---

## 1. Why this brief exists

USDA FAS deploys agricultural attachés in over 90 countries — including dedicated posts for Venezuela (Caracas), Dominican Republic (Santo Domingo), and the Caribbean Basin Agricultural Trade Office (CBATO Miami serving the smaller islands). These attachés publish ~5-15 narrative reports per country per year covering:

- **Exporter Guide** (annual) — country market overview written explicitly to help US exporters identify importers, distributors, and channel structure
- **Food Service – Hotel, Restaurant, Institutional (HRI)** (typically annual) — names the major food-service operators and the distributors who supply them
- **Retail Foods** (annual) — names the major retail chains, importers, and wholesalers in the consumer food sector
- **Grain and Feed Annual + Update** — names major grain importers, feed millers, and millers; this is where you find Empresas Polar, Molinos Nacionales, and equivalents identified explicitly
- **Oilseeds and Products Annual + Update** — names major soybean / soybean oil / soybean meal importers
- **Sugar Annual** — names sugar importers and refiners
- **Poultry and Products Annual + Update** — names protein importers and integrators
- **Country-specific topical reports** — ad-hoc analysis of specific market events, regulatory changes, or sector dynamics

Every one of these reports is a PDF, free to download, published at `apps.fas.usda.gov/newgainapi/`. Together, the reports for procur's seed Caribbean basin countries represent **~150-200 reports over the last 5 years**, each typically naming 5-15 specific companies in the body text with USDA's commentary on their market position.

Three operational gaps this closes:

**(a) The named-importer dataset already exists, in plain English, in PDFs nobody is mining.** A USDA attaché writing about Venezuela's wheat sector will name Empresas Polar, Molinos Nacionales, Cargill de Venezuela, and the smaller mills, alongside their estimated market share and source-of-supply preference. This is exactly the data Volza / Datamyne / Panjiva sell, except USDA already wrote it down and published it free. The work has been done; what's missing is structured ingestion.

**(b) The reports include qualitative context that customs data never can.** Mirror-customs data names exporters; GAIN reports name importers *and* explain why they matter ("Empresas Polar dominates wheat flour and continues to source from the US despite Venezuela's economic constraints"; "Group A Cordovés is the major importer in DR for branded consumer food products and operates a portfolio of supermarket banners under La Sirena and Jumbo"). For supplier outreach and pitch positioning, the narrative context is operationally more valuable than the raw volume number.

**(c) USDA attachés re-validate this intelligence annually.** The reports are refreshed on a regular cadence by the in-country attachés; an importer that drops out of the narrative has likely lost relevance or exited the category. The dataset self-curates over time, giving procur a free analyst-in-country signal that no scraping pipeline could replicate.

The Venezuela opportunity specifically benefits because USDA's Caracas post resumed regular reporting in 2024 after years of disruption, and the May 2025 report (and subsequent updates) explicitly cover the supplier landscape for the $3B ag import market.

---

## 2. Scope and non-scope

### In scope

- Scraping the GAIN search API for the country seed list (Venezuela, Jamaica, Dominican Republic, Trinidad & Tobago, Guyana, Suriname, Haiti, Colombia, Panama, Cuba)
- Downloading PDFs for ~150-200 reports covering the last 5 years (one-shot backfill) and ~20-30 new reports per quarter ongoing
- LLM-driven extraction of named companies, their role (importer / distributor / retailer / food service / miller / refiner / integrator), the commodity category, the source-of-supply preference, and the surrounding narrative context
- A `gain_importer_mentions` table holding per-mention extracted records with provenance back to the source PDF + paragraph
- A `gain_reports` table cataloguing the report metadata (country, type, date, attaché author when present, URL, file hash)
- Entity-resolution integration with `known_entities` using the same two-phase pattern as the mirror-customs brief
- One new chat tool: `lookup_named_importers_by_country` returning USDA-named importers for a (country, commodity category) query
- One enhancement to existing entity profile pages: a "USDA mentions" card surfacing all GAIN reports referencing the entity
- One new intelligence surface: `/intelligence/gain-importers` with a country × commodity importer matrix
- Quarterly Trigger.dev cron checking for new reports

### Out of scope (deliberately)

- **Re-extracting all USDA reports globally.** The seed-country list is the focus; reports for non-seed countries are skipped at ingest time. Easy to expand later.
- **Non-PDF GAIN content.** The GAIN system also publishes some Excel attachments (commodity production tables, regulation indices); structured-data extraction for those is a follow-up if narrative extraction proves the value.
- **Translation of non-English reports.** GAIN reports are written in English by US FAS staff regardless of country. No translation needed.
- **OCR for scanned reports.** GAIN reports are text-native PDFs in essentially all cases; OCR fallback is implemented but expected to be rarely needed.
- **Bond prospectus / 10-K / NI 43-101 extraction.** These are separate PDF-extraction pipelines already specced in `buyer-intelligence-v2-free-sources-brief.md` §4.1 and §4.3. This brief reuses the LLM extraction pattern but does not subsume those workstreams.
- **Sentiment scoring or competitive ranking.** The extraction surfaces what USDA wrote; interpretation (Is this importer growing? Are they aggressive in the market?) stays with the analyst, not the LLM.
- **Real-time / event-triggered ingest.** Quarterly cadence is the ceiling; new reports publish steadily but not urgently.

---

## 3. GAIN data source mechanics

### 3.1 Access pattern

GAIN reports are searchable and downloadable through two endpoints:

- **Search front-end:** `gain.fas.usda.gov` — single-page React app for human browsing; backed by a search API at `apps.fas.usda.gov/newgainapi/api/Report/SearchReports`
- **Direct download:** `apps.fas.usda.gov/newgainapi/api/Report/DownloadReportByFileName?fileName={URL-encoded filename}`

The download URL pattern is stable and observable across reports going back to the 1990s; filenames follow the convention `{Report Title}_{Post City}_{Country}_{Report ID or Date}`. Examples observed in the wild:

- `Venezuela+Agricultural+Imports+Grow+9+Percent+in+2024+with+the+United+States+among+Leading+Suppliers_Caracas_Venezuela_VE2025-0008`
- `Oilseeds+and+Products+Annual_Vienna_European+Union_04-01-2021`

The search API accepts country, report type, date range, and free-text query filters. No API key is required (no auth headers observed). Rate limits are not documented but observed in practice to be generous.

### 3.2 Report taxonomy

USDA classifies GAIN reports by type. The types most relevant for named-importer extraction:

| Report Type | Frequency | Importer Mentions |
|---|---|---|
| Exporter Guide | Annual | High — named distributors + importers by category |
| Food Service - Hotel, Restaurant, Institutional | Annual | High — names major HRI operators + suppliers |
| Retail Foods | Annual | High — names retail chains + importers + wholesalers |
| Grain and Feed Annual | Annual | High — named millers + feed importers |
| Grain and Feed Update | Semi-annual or quarterly | Medium — sometimes references the players from Annual |
| Oilseeds and Products Annual | Annual | High — named oilseed importers + crushers |
| Oilseeds and Products Update | Semi-annual or quarterly | Medium |
| Sugar Annual | Annual | Medium — named refiners + importers |
| Livestock and Products Annual | Annual | Medium — named importers + integrators |
| Poultry and Products Annual | Annual | Medium — named protein importers |
| Dairy and Products Annual | Annual | Medium — named dairy importers |
| Country-specific ad-hoc | Variable | Variable |
| FAIRS / SPS / regulatory | Variable | Low — names regulators, not importers |

The first eight types are the high-yield set the scraper prioritizes. Regulatory reports (FAIRS = Food and Agricultural Import Regulations and Standards, SPS = Sanitary and Phytosanitary) are filtered out at ingest since they name government agencies rather than commercial counterparties.

### 3.3 Document characteristics

- Typical length: 5-40 pages; Exporter Guides run longest (20-40), updates are shorter (5-15)
- Text-native PDFs in essentially all cases (post-2000 reports)
- Standardized section structure: Executive Summary → Market Overview → Distribution / Consumption channels → Specific commodity analysis → Trade data tables → Post Contact
- Named-importer mentions concentrate in: "Market Overview," "Distribution Channels," "Major Importers / Distributors / Retailers," and section-specific commodity discussions
- The named-importer concentration ratio: across the high-yield report types, expect 5-15 distinct named importers per report, with the highest density in Exporter Guides

---

## 4. LLM extraction pipeline

### 4.1 Extraction model and approach

Reuses the existing `@procur/ai` infrastructure (Anthropic Claude routed via Cloudflare AI Gateway when configured). The pipeline matches the pattern documented in `buyer-intelligence-v2-free-sources-brief.md` §4.1 for bond prospectus extraction:

**Stage 1 — Section identification:** Parse the PDF into text (pdfjs / pdf-parse). Split into sections by detected headers. Identify candidate sections likely to contain importer mentions ("Market Overview," "Distribution," "Channel of Distribution," "Major Players," "Importers," "Retail Sector," "Food Service Sector," and any commodity-specific sections like "Wheat Imports," "Soybean Oil Sector"). Discard reference tables, regulatory annexes, and the contact section.

**Stage 2 — Per-section extraction:** Pass each candidate section to Claude with a structured prompt requesting:
- Named companies mentioned (legal name + any abbreviation or local name variant)
- Role classification (importer / distributor / wholesaler / retailer / food service operator / miller / refiner / integrator / multi-role)
- Commodity category (one or more from a controlled vocabulary aligned with HS6 chapters)
- Market position (USDA's stated estimate: dominant / major / emerging / declining / unknown)
- Source-of-supply preferences (countries / regions USDA notes the importer prefers)
- The quoting excerpt: 1-3 sentences from the source giving the context
- Confidence (LLM self-rated 0-1) on whether the mention is genuinely a commercial counterparty vs. a passing reference

**Stage 3 — Cross-section deduplication:** Within a single report, the same company often appears in multiple sections. Collapse to one row per (report, company) with the union of commodity tags + the highest market-position rating + concatenated context excerpts.

**Stage 4 — Persistence:** Insert into `gain_importer_mentions` with full provenance. Each row links back to the source PDF + the page or section where the mention appeared.

**Stage 5 — Entity resolution:** Same two-phase pattern as mirror-customs:
1. Name-normalized match against `known_entities`
2. Fuzzy match for variations
3. Auto-create stub `known_entities` with `kind='importer_candidate'`, `country` from the report, `metadata.created_by='gain_extraction'`, low resolution confidence pending analyst review

### 4.2 Prompt design

The extraction prompt is structured around:

1. **Role definition.** "You are a research analyst extracting named commercial counterparties from a USDA Foreign Agricultural Service country report. The goal is to identify importing companies, distributors, and retailers that procur — an AI-powered commodity-trading platform — should know about."

2. **Schema specification.** A typed JSON schema for the output, enforced by Claude's structured-output capability or via post-parse validation.

3. **Boundary constraints.** "Do not invent companies. Only extract names that appear verbatim in the source text. Do not extract government agencies, regulators, or non-commercial entities. For each name, quote the original text that mentions it. If the section contains no commercial counterparties, return an empty list."

4. **Examples.** Two or three high-quality extraction examples (one from a Venezuela report, one from a DR report) showing exactly what good output looks like for similar source text. Examples include intentional edge cases (acronyms, parent-company-vs-subsidiary, joint ventures).

5. **Failure modes to avoid.** "Do not extract names that appear only in lists of regulators or trade associations. Do not aggregate multiple distinct mentions into one summary. Do not paraphrase quoted text."

### 4.3 Quality controls

- **Per-batch validation:** every extraction batch runs a sampler on 5% of outputs, asking a second Claude pass to grade whether each extracted record is a genuine commercial counterparty mention vs. a false positive. Records flagged by the validator are queued for analyst review rather than auto-persisted.
- **Cross-report consistency:** if a company appears in 3+ separate GAIN reports across different years, its market-position assessment should be reasonably consistent. Significant disagreement (e.g., "dominant" in 2022, "declining" in 2024, "dominant" again in 2025) flags either a real market shift or extraction noise; surface for analyst review.
- **Manual seed validation:** before the first full backfill, run the extractor on three known reports (a Venezuela Grain and Feed Annual, a DR Retail Foods, a Jamaica Exporter Guide) and have an analyst grade the outputs by hand. Target: ≥85% precision on named-importer extraction, ≥75% recall against an independent analyst pass on the same reports.
- **Negative-case validation:** the prompt must correctly produce an empty extraction list when run against statistical / market-summary reports that contain no named commercial counterparties. The canonical negative test fixture is `data/gain-reference-samples/VE2026-0002_US-Venezuelan-Agricultural-Trade-Summary-2025.md` — a USDA Caracas trade summary that is rich in macro tables (origin shares, top commodities, price trends) but names no Venezuelan importers, distributors, or retailers. A correct extraction returns zero importer mentions; any non-empty output for this fixture is a hallucination regression and must fail CI.

### 4.4 Cost estimate

- Average GAIN report: ~10-15 pages, ~6-8k tokens of body text
- Per-report extraction: roughly 3-5 LLM calls (one per candidate section after splitting), ~10-15k input tokens + ~2-3k output tokens total
- At Claude Sonnet 4 / 4.5 rates: roughly $0.15-0.25 per report
- **One-shot backfill (~200 reports):** ~$30-50 total
- **Quarterly delta (~25 new reports/quarter):** ~$5-10 per quarter
- The cost is logged in the existing cost ledger as `llm.extract / gain-pipeline / N reports / $X`

---

## 5. Schema additions

Two additive tables.

### 5.1 `gain_reports`

Catalogue of every GAIN report procur has observed, regardless of extraction status. Acts as the dedup + idempotency anchor for the scraper.

```sql
CREATE TABLE gain_reports (
  id              TEXT PRIMARY KEY,                    -- ULID
  report_id       TEXT,                                -- USDA's internal report ID (e.g., 'VE2025-0008')
  country_code    TEXT NOT NULL,                       -- ISO-2 of report subject country
  post_city       TEXT,                                -- 'Caracas', 'Santo Domingo', 'Kingston', etc.
  report_type     TEXT NOT NULL,                       -- 'Exporter Guide' | 'Retail Foods' | etc. — normalized
  title           TEXT NOT NULL,
  publication_date DATE,
  source_filename TEXT NOT NULL,                       -- the URL-encoded filename component
  source_url      TEXT NOT NULL,                       -- full download URL
  pdf_blob_url    TEXT,                                -- Vercel Blob storage for the cached PDF
  pdf_sha256      TEXT,                                -- content hash for change detection
  pdf_page_count  INTEGER,
  extraction_status TEXT NOT NULL DEFAULT 'pending',   -- 'pending' | 'extracted' | 'failed' | 'skipped'
  extraction_attempted_at TIMESTAMP,
  extraction_completed_at TIMESTAMP,
  extraction_error TEXT,
  raw_metadata    JSONB,                               -- full search-API response for audit
  discovered_at   TIMESTAMP NOT NULL DEFAULT NOW(),
  created_at      TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE (source_filename)
);
CREATE INDEX idx_gain_reports_country_date ON gain_reports (country_code, publication_date DESC);
CREATE INDEX idx_gain_reports_pending ON gain_reports (extraction_status, discovered_at) WHERE extraction_status = 'pending';
```

### 5.2 `gain_importer_mentions`

```sql
CREATE TABLE gain_importer_mentions (
  id              TEXT PRIMARY KEY,                    -- ULID
  report_id       TEXT NOT NULL REFERENCES gain_reports(id),
  company_name    TEXT NOT NULL,                       -- as written in the source
  company_name_normalized TEXT NOT NULL,               -- lowercase, suffix-stripped, for resolution
  roles           TEXT[] NOT NULL,                     -- ['importer', 'distributor', 'miller', etc.]
  commodity_categories TEXT[] NOT NULL,                -- ['wheat', 'soybean_oil', 'sugar', etc.]
  market_position TEXT,                                -- 'dominant' | 'major' | 'emerging' | 'declining' | 'unknown'
  supply_preferences TEXT[],                           -- ['US', 'Brazil', 'Argentina', etc.]
  context_excerpt TEXT NOT NULL,                       -- 1-3 sentences from the source
  source_section  TEXT,                                -- which section of the report this appeared in
  source_page     INTEGER,                             -- approximate page number
  extraction_confidence NUMERIC NOT NULL,              -- LLM self-rated 0-1
  validator_grade TEXT,                                -- 'confirmed' | 'flagged' | 'rejected' | null (not yet sampled)
  resolved_entity_id TEXT,                             -- FK to known_entities.id after resolution
  resolution_confidence NUMERIC,
  resolution_method TEXT,
  extracted_at    TIMESTAMP NOT NULL DEFAULT NOW(),
  created_at      TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_gain_mentions_report ON gain_importer_mentions (report_id);
CREATE INDEX idx_gain_mentions_company_normalized ON gain_importer_mentions (company_name_normalized);
CREATE INDEX idx_gain_mentions_entity ON gain_importer_mentions (resolved_entity_id) WHERE resolved_entity_id IS NOT NULL;
CREATE INDEX idx_gain_mentions_unresolved ON gain_importer_mentions (resolved_entity_id) WHERE resolved_entity_id IS NULL;
```

The same `(company_name, country_code)` may appear in many reports over time. Each mention is preserved separately rather than collapsed — the multi-mention pattern *is* the signal (a company referenced in 5 reports across 4 years is structurally important; a company referenced once may be ephemeral). Aggregate views collapse them at query time.

---

## 6. Service layer architecture

### 6.1 Package layout

New package `packages/integrations/src/gain-extraction/`:

```
packages/integrations/src/gain-extraction/
  scraper.ts             # GAIN search + PDF download
  parser.ts              # PDF text + section splitting
  extractor.ts           # LLM extraction with structured output
  validator.ts           # Quality control sampling
  resolver.ts            # Entity resolution (shares logic with mirror-customs resolver)
  prompts.ts             # Versioned extraction prompts
  schema.ts              # Zod types for LLM output
  types.ts
  index.ts
```

### 6.2 Pipeline stages

```
[Scraper]        — discover new reports via search API
   ↓
[Download]       — fetch PDF, cache in Vercel Blob, hash
   ↓
[Parser]         — extract text + identify candidate sections
   ↓
[Extractor]      — per-section LLM call with structured output
   ↓
[Deduper]        — collapse within-report duplicates
   ↓
[Validator]      — sample 5% for quality grading
   ↓
[Persister]      — insert into gain_importer_mentions
   ↓
[Resolver]       — match to known_entities or auto-create
   ↓
[Signal Emitter] — emit gain.new_importer_mention for unresolved auto-creates
```

Each stage is implemented as a discrete function so the pipeline can be re-run from any checkpoint without re-paying earlier costs (LLM extraction is the expensive step; PDFs cached in Blob means re-parsing is free).

### 6.3 Trigger.dev jobs

Two jobs:

**`gain-extraction-quarterly` (1st of January / April / July / October, 04:00 UTC):**
1. Hit the GAIN search API for each country in seed list, filtered to publications since the last run
2. For each discovered report not already in `gain_reports`, insert metadata + queue download
3. For each queued report: download PDF, parse, extract, validate, persist, resolve
4. Emit progress events; complete in batches to handle backfill volumes gracefully

**`gain-extraction-backfill` (one-shot, manual trigger):**
- Same pipeline as quarterly, but for all reports of the high-yield types from the last 5 years
- Run once at integration time; ~200 reports, ~$30-50 LLM cost

### 6.4 Reuse with mirror-customs resolver

The entity-resolution logic in `packages/integrations/src/gain-extraction/resolver.ts` shares the same matching primitives as `packages/integrations/src/mirror-customs/resolver.ts` (name normalization, suffix stripping, fuzzy match, auto-create stub pattern). Both packages depend on a shared `packages/integrations/src/entity-resolution/` module to avoid duplication.

Cross-source corroboration is a deliberate design property: when the mirror-customs scraper observes an Argentine exporter shipping wheat to Venezuela, and the GAIN extraction observes "Molinos Nacionales" as a major Venezuelan wheat importer in the Grain and Feed Annual, the two records *combined* describe a likely trade lane even though neither source names both ends. Procur's join across the two tables on (commodity, country, time period) surfaces these inferred lanes for analyst review.

---

## 7. Integration surfaces

### 7.1 Chat tools

**`lookup_named_importers_by_country`** — answers "who are the major wheat importers in Venezuela per USDA?"
- Input: `{ countryCode: 'VE', commodityCategory?: 'wheat', minMarketPosition?: 'major' }`
- Output: ranked list of named importers, each with role tags, market position, supply preferences, count of GAIN reports referencing them, most recent mention date, and resolved entity profile link
- The tool cites USDA explicitly so the assistant doesn't represent USDA narrative as procur's own assessment

### 7.2 Entity profile enhancement

For any `known_entities` row resolved via GAIN extraction, the entity profile page gets a "USDA mentions" card showing:
- Count of GAIN reports referencing this entity
- Timeline of mentions across years
- Most recent narrative excerpt USDA wrote about them
- Commodity categories they're associated with
- Inline "View source report" link to the cached PDF in Vercel Blob

### 7.3 `/intelligence/gain-importers` page

Single new route. Three views:

**Top: Country × commodity importer matrix**
- Rows = countries in seed list, columns = commodity categories, cells = count of named importers USDA has identified at "major" or "dominant" market position
- Hover any cell → list of named importers with most recent USDA excerpt

**Middle: Importer deep-dive panel** (when one is selected)
- All GAIN reports referencing the importer, chronologically
- All commodity categories associated
- All supply preferences USDA has noted
- Cross-link: any mirror-customs shipment records where the importer's country matches and commodity overlaps (inferred trade lane)
- Cross-link: any sanctions / KYC screens already run on the resolved entity

**Bottom: Unresolved-mention queue**
- Pending entity-resolution items requiring analyst review
- Inline confirm / merge / reject actions

### 7.4 Signals

One new signal type:

- `gain.new_importer_mention` — fires when a new (importer, country) combination is extracted and auto-creates a stub entity. Severity: info. Surfaces in the unresolved-mention queue for analyst review.

A second signal type to consider for v2:

- `gain.market_position_change` — fires when an existing importer's market position in successive USDA reports changes meaningfully (e.g., "major" → "declining"). Severity: medium. Useful as a "this counterparty is losing market share, opportunity for a replacement supplier" signal.

---

## 8. Operational sequencing

Suggested implementation order (4–6 days total):

**Day 1 — foundation**
- Migrations for `gain_reports` + `gain_importer_mentions`
- Scraper for the GAIN search API + PDF download
- Vercel Blob storage integration for cached PDFs
- Smoke test: pull the 3 most recent Venezuela reports, store metadata, cache PDFs

**Day 2 — PDF parsing + section identification**
- Implement PDF-to-text with pdfjs / pdf-parse
- Section header detection heuristics (regex + position-based)
- Candidate-section filter (keep market overview, distribution, importer-specific sections; drop regulatory annexes)
- Validate against the 3 cached Venezuela reports by hand

**Day 3 — LLM extraction prompt + structured output**
- Write extraction prompt (v1) with examples from Venezuela + DR reports
- Implement structured-output validation via Zod
- Run extraction on 3 known positive-case reports (Venezuela Grain and Feed Annual, DR Retail Foods, Jamaica Exporter Guide), manually grade outputs
- Run extraction on the negative-case fixture at `data/gain-reference-samples/VE2026-0002_US-Venezuelan-Agricultural-Trade-Summary-2025.md`; verify zero importer mentions returned
- Iterate on prompt until precision ≥85% on the positive set AND zero false positives on the negative fixture
- Persist initial outputs to `gain_importer_mentions`

**Day 4 — entity resolution + validator pass**
- Resolver implementation (shared with mirror-customs if that brief ships first)
- Validator second-pass sampling
- Run resolution on Day 3 outputs; review auto-created stubs with analyst

**Day 5 — backfill + signal emission**
- Run quarterly cron logic in backfill mode against the full 5-year history for seed countries
- Monitor LLM cost ledger; spot-check 10% of outputs
- Emit signals for new importer mentions

**Day 6 — surfaces + polish**
- Chat tool registration
- Entity profile "USDA mentions" card
- `/intelligence/gain-importers` page with three views
- README + CLAUDE.md additions documenting the quarterly cadence + cost expectations

---

## 9. Cost and operational accounting

- **Data cost: $0.** GAIN reports are free; no API key required for the search or download endpoints.
- **LLM cost:** ~$30-50 one-shot backfill, ~$5-10 per quarter ongoing. Logged in cost ledger.
- **Storage:** ~200 PDFs at avg ~2 MB each = ~400 MB in Vercel Blob. `gain_reports` ~200 rows; `gain_importer_mentions` expected ~1,500-3,000 rows after backfill (avg 8-15 importers per report). Trivial for Neon.
- **Bandwidth:** quarterly delta ~25 reports × 2 MB = ~50 MB per quarter download.
- **Maintenance:** GAIN portal structure has been stable for ~10 years; expected scraper maintenance ~1 day per year. Prompt versioning + occasional re-runs for prompt improvements ~1 day per year.

---

## 10. What this brief deliberately doesn't include

- **Quantitative volume / value estimates.** GAIN reports include trade data tables in some cases but the structured-data extraction from those tables is a separate workstream (out of scope here). The qualitative named-importer extraction is the focus; volume data comes from the FAS Open Data integration (`fas-opendata-brief.md`).
- **Non-FAS narrative sources** (IMF Article IV, IDB country reports, Economist Intelligence Unit country reports). The LLM extraction pattern is reusable for these and a clean follow-up; out of scope for this brief to keep scope tight.
- **Bond prospectus extraction** (already specced in `buyer-intelligence-v2-free-sources-brief.md` §4.1).
- **NI 43-101 mining report extraction** (already specced in §4.3).
- **EITI report extraction** (already specced in §4.5).
- **Embassy / chamber of commerce narrative scraping** — different source class, defer.
- **Translation of non-English narrative reports.** Not applicable to GAIN (English by definition) but applicable to other source classes; defer to per-source briefs.
- **Inferred trade-lane joins between mirror-customs and GAIN** as a write-able relationship in the data graph. The cross-link surfaces on the UI side; persisting inferred lanes as a graph edge is a follow-up.

---

## 11. Success metrics

Within 30 days of ship:
- All seed-country GAIN reports from the last 3 years (the high-yield set, ~120 reports) have been ingested + extracted
- At least 400 named Caribbean / LATAM food importers have been extracted and resolved (auto or manual) into `known_entities`
- The Venezuela importer matrix shows at least 25 named importers across the food commodity categories
- At least one outbound supplier engagement has cited a USDA GAIN narrative excerpt as part of the pitch context
- The cross-link between mirror-customs and GAIN mentions has surfaced at least 10 plausible inferred trade lanes for analyst review

Within 90 days:
- The full 5-year backfill is complete
- The unresolved-mention queue runs at <30 pending items at steady state
- The "USDA mentions" card on entity profiles is being consulted by the assistant in chat sessions involving Caribbean basin counterparties
- At least 3 supplier or importer outreach campaigns have been informed by GAIN-extracted intelligence

---

## Open decisions before build

1. **Backfill horizon.** 5 years is the default but older reports (2010-2020) still have intelligence value for long-standing importers. Default: 5 years for v1, evaluate going deeper after the first quarterly delta confirms the pipeline works.
2. **Validator sample rate.** 5% sampling is the default; higher rates increase cost without proportional quality gain once the prompt is mature. Default: 5% in v1, adjust based on observed precision.
3. **Auto-create threshold.** GAIN mentions auto-create entity stubs by default (same pattern as mirror-customs). Alternative: hold all unresolved mentions in a staging area requiring manual confirmation. Default: auto-create, since GAIN mentions are higher-quality than customs-record mentions (USDA already curated them) and the backlog cost of manual confirmation would be high.
4. **Prompt versioning + re-extraction.** As the prompt improves over time, should historical reports be re-extracted with the new prompt? Default: yes, but only on explicit "re-extract" command and only for the validator-flagged subset. Don't re-extract the whole corpus on every prompt revision.
5. **Whether to extract from regulatory / SPS / FAIRS reports for non-importer mentions.** These reports name regulators and standards bodies that could be useful context but aren't commercial counterparties. Default: skip in v1; if a deal team raises the question of regulatory contacts, ingest those reports separately with a different extraction prompt.

---

## Phase 0 sign-off

No external dependencies block Day 1. GAIN endpoints are publicly accessible; LLM extraction reuses existing `@procur/ai` infrastructure; schema is additive only.

Next action: scaffold the migrations + scraper, smoke-test on the 3 most recent Venezuela reports (Grain and Feed Annual 2024, Exporter Guide 2024, the May 2025 Venezuela Ag Imports report), validate the extraction prompt against hand-graded ground truth, then proceed to backfill.
