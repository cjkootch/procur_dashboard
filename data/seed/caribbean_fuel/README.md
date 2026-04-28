# Caribbean Fuel — Seed Data

Test fixtures and analytical artifacts for the supplier-graph + reverse-search build (see `docs/supplier-graph-brief.md`).

## What's in this folder

| File | Size | What it is |
|---|---|---|
| `awards_sample.json` | ~90KB | **105-row stratified sample** of the master awards dataset. Covers top 10 DR fuel suppliers (5 rows each), 50 random long-tail rows, plus 5 GOJEP/Jamaica rows for portal diversity. Use this for unit tests and integration tests. |
| `dossiers/master_database.xlsx` | 627KB | Full supplier database — 5,982 awards across 282 suppliers, ~$750M tracked contract value. 5 sheets: Cover, Suppliers, Heatmap, Buyers, Awards. **Reference data for analysis, not for ingestion.** |
| `dossiers/top10.xlsx` | 28KB | Enriched dossiers for the top 10 DR fuel suppliers — ownership, decision-makers, capability assessment, recommended outreach. **Strategic reference, not for ingestion.** |

## What's NOT in this folder (and where to get it)

The full ~6,000-row awards dataset is **not checked in**. Reasons:

1. It's 4.8MB — bloats the repo without paying its way.
2. It's regenerable in ~10 min from the public OCDS source.
3. It goes stale the moment DR DGCP publishes new data.

To regenerate the full dataset, run the scrapers in `scripts/scrapers/caribbean_fuel/`. See that folder's README.

## Sample row → `awards` table schema mapping

The sample uses the scraper's intermediate JSON shape. When ingesting into the production `awards` table (per the brief in `docs/supplier-graph-brief.md`), map fields as follows:

| Sample JSON field | `awards` table column | Notes |
|---|---|---|
| `source_portal` | `source_portal` | Direct |
| `award_id` | `source_award_id` | Direct |
| `ocid` | (raw_payload) | Stash in `raw_payload` for OCDS traceability |
| `buyer` | `buyer_name` | Direct |
| `buyer_country` | `buyer_country` | ISO-3 in sample → convert to ISO-2 (`DOM`→`DO`, `JAM`→`JM`) |
| `tender_title` | `title` | Direct |
| `tender_title` (joined with description) | `commodity_description` | Concat tender_title + line items |
| `unspsc_codes` | `unspsc_codes` | Already array — dedupe before insert |
| `fuel_categories` | `category_tags` | Already pre-classified by scraper |
| `award_date` | `award_date` | ISO-8601 strings |
| `value_native` | `contract_value_native` | Direct |
| `value_currency` | `contract_currency` | Direct |
| `value_usd` | `contract_value_usd` | FX conversion done at scrape time |
| `award_status` | `status` | OCDS uses `active`/`cancelled`/`unsuccessful` — maps cleanly |
| `supplier_name` | (resolved to external_suppliers FK via aliases) | See note below |
| `supplier_name_normalized` | (used during alias resolution) | Lowercased, suffix-stripped |
| `supplier_id` | (raw_payload + alias source_id) | Portal's native supplier ID |

### Supplier resolution flow at ingest

For each award row:

1. Look up `supplier_name_normalized` in `supplier_aliases.alias_normalized`.
2. **Hit:** use the canonical `supplier_id` from the alias row.
3. **Miss:** create a new `external_suppliers` row + a `supplier_aliases` row pointing to it (`confidence=1.0`, `verified=false`). Flag for human review later.
4. **Fuzzy match (trigram similarity > 0.85):** create a `supplier_aliases` row pointing to the existing supplier (`confidence=<similarity>`, `verified=false`). Flag for human review.

Insert one `awards` row + one `award_awardees` row (with `role='prime'`). Consortium awards aren't in the sample data — when they appear, parse `parties` array from OCDS and insert one `award_awardees` row per consortium member.

## Sample dataset characteristics

- **Date range:** 2021-03-31 → 2026-03-11
- **Suppliers covered:** 55 unique
- **Portals covered:** `DR_DGCP_OCDS` (Dominican Republic), `GOJEP` (Jamaica)
- **Countries covered:** `DOM`, `JAM`
- **Fuel categories represented:** diesel, gasoline, aviation, heating_oil, heavy_fuel_oil, crude
- **Currency mix:** DOP (Dominican peso), JMD (Jamaican dollar), USD

The top 10 supplier names that appear in the sample (in alphabetical order):

- ECO PETROLEO DOMINICANA, S.A.
- Estación De Servicios Coral, SRL
- Gas Antillano, SAS
- Gulfstream Petroleum Dominicana, S de RL
- Isla Dominicana de Petroleo Corporation
- Next Dominicana, SA
- PETROMOVIL, S.A.
- Sigma Petroleum Corp, SAS
- Sunix Petroleum, SRL
- Totalenergies Marketing Dominicana, S.A.

These are the entities profiled in `dossiers/top10.xlsx` — useful when writing test cases that assert reverse-search results match expected suppliers.

## Use in tests

For unit tests of `findBuyersForCommodityOffer()` and the supplier graph ingestion pipeline:

```ts
import sampleAwards from '../data/seed/caribbean_fuel/awards_sample.json' assert { type: 'json' };

// Smoke test — diesel reverse search should find DR government buyers
const buyers = await findBuyersForCommodityOffer({
  categoryTag: 'diesel',
  buyerCountries: ['DO'],
  yearsLookback: 5,
  minAwards: 2,
});
expect(buyers.length).toBeGreaterThan(0);
expect(buyers[0].buyerCountry).toBe('DO');
```

## Regenerating the full dataset

See `scripts/scrapers/caribbean_fuel/README.md`.

## Provenance

- **DR data:** Dominican Republic DGCP OCDS bulk publication, https://data.open-contracting.org/en/publication/22 — public open data, OGL-3.0
- **Jamaica data:** GOJEP (Government of Jamaica Electronic Procurement), https://www.gojep.gov.jm — public records scraped from notice PDFs
- **Enrichment data in `top10.xlsx`:** synthesized from public corporate websites, MICM regulatory filings, news/press releases, industry directories, LinkedIn — all open sources

## Last regenerated

- Sample: 2026-04-28
- Master DB: 2026-04-28
- Top 10 dossier: 2026-04-28
