# Caribbean Fuel Scrapers

Two scrapers that produce the awards dataset feeding the supplier graph (see `docs/supplier-graph-brief.md` and `data/seed/caribbean_fuel/`).

## What's here

| File | Purpose |
|---|---|
| `dr_extractor.py` | Downloads DR DGCP OCDS bulk JSONL.gz files (2021-2025), filters for petroleum-fuel awards via UNSPSC class 1510, emits per-award rows. ~5,964 fuel awards over the lookback period. |
| `gojep_scraper.py` | Paginates GOJEP HTML search by fuel keywords, downloads notice PDFs, extracts awardee data via `pdftotext`. ~19 fuel-supply awards. |
| `build_master_db.py` | Merges DR + GOJEP outputs into the consolidated `caribbean_fuel_awards_master.json` and the analytical `master_database.xlsx`. |

## Why only DR and Jamaica?

OCDS coverage in the Caribbean is uneven:

- **DR** publishes full OCDS bulk data — clean, queryable, complete.
- **Jamaica (GOJEP)** publishes notices on their portal but no OCDS feed — requires HTML+PDF scraping.
- **Trinidad, Barbados, Bahamas, Guyana, Suriname** all have national portals but no machine-readable feed. Custom scrapers needed per portal.
- **French Caribbean, Haiti, Cuba** out of scope.

Adding Trinidad/Guyana scrapers is a v2 expansion — separate brief.

## Running locally

### Prerequisites

```bash
# Python 3.11+
pip install requests beautifulsoup4 lxml

# pdftotext (for GOJEP)
brew install poppler        # macOS
apt-get install poppler-utils  # Linux
```

### DR DGCP OCDS

```bash
cd scripts/scrapers/caribbean_fuel
python3 dr_extractor.py
```

What it does:

1. Fetches the OCDS publication index from `data.open-contracting.org/en/publication/22`
2. Downloads JSONL.gz files for 2021-2025 (~290MB total — caches locally as `dr_*.jsonl.gz`)
3. Streams through each release, keeps only awards where any line item carries a UNSPSC code in class 1510 (Petroleum and distillates)
4. Outputs `dr_fuel_awards.json` (~5,964 rows)

Runtime: ~10 min on a fast connection (mostly download).

**Re-running is idempotent** — the gz files are cached. Delete them to force a fresh download.

### GOJEP (Jamaica)

```bash
python3 gojep_scraper.py
```

What it does:

1. Searches GOJEP for fuel keywords (`diesel`, `gasoline`, `petroleum`, `kerosene`, `lpg`, `heavy fuel oil`, `aviation fuel`)
2. Paginates through results
3. Downloads each award notice PDF
4. Runs `pdftotext` and parses awardee + value from the structured PDF
5. Outputs `gojep_fuel_awards.json` (~19 rows)

Runtime: ~3 min.

**Polite scraping:** 1-second delay between requests, identifies via descriptive User-Agent. Don't change this without thinking about it — GOJEP has no rate-limit headers but they'll notice an aggressive scraper.

### Build master DB

```bash
python3 build_master_db.py
```

Merges the two JSON outputs into:

- `caribbean_fuel_awards_master.json` — flat normalized awards (5,982 rows total)
- `caribbean_fuel_supplier_database.xlsx` — analytical workbook (Cover, Suppliers, Heatmap, Buyers, Awards)

## Output schema

Each row in the master JSON has these fields. See `data/seed/caribbean_fuel/README.md` for the field-by-field mapping to the production `awards` table.

```json
{
  "country": "DOM",
  "source_portal": "DR_DGCP_OCDS",
  "ocid": "ocds-6550wx-...",
  "tender_id": "...",
  "tender_title": "...",
  "buyer": "...",
  "buyer_country": "DOM",
  "supplier_name": "...",
  "supplier_name_normalized": "...",
  "supplier_id": "DO-RPE-...",
  "award_id": "...",
  "award_date": "2024-06-21",
  "award_status": "active",
  "value_native": 624300,
  "value_currency": "DOP",
  "value_usd": 10405.0,
  "fuel_categories": ["diesel", "gasoline"],
  "unspsc_codes": ["15101506", "15101505"]
}
```

## Known issues

1. **DR award values are reported in DOP** — USD conversion uses a single exchange rate (currently hardcoded ~60 DOP/USD). For high-value comparisons, a date-aware FX lookup would be more accurate.
2. **GOJEP PDFs vary in layout** — older notices (pre-2022) sometimes parse incorrectly. Spot-check before relying on award values from those years.
3. **Supplier name normalization is naive** — lowercases and strips common suffixes (SRL, S.A., LLC, etc.). Doesn't catch all variants. The `supplier_aliases` table in the production schema is designed to absorb this messiness with a fuzzy-match resolution layer.
4. **Fuel category classification** is rule-based on keywords + UNSPSC codes. Some edge cases (e.g. "lubricantes" → not really fuel) get included. Filter at query time if needed.

## Wiring into the production ingestion pipeline

The brief in `docs/supplier-graph-brief.md` describes an `awards` table designed to absorb this output. The intended flow:

1. Run scrapers → JSON output in `data/seed/caribbean_fuel/` (or anywhere else)
2. Ingestion service (in `services/ingestion/` — to be built) reads JSON, resolves suppliers via `supplier_aliases`, inserts into `awards` + `award_awardees`
3. Nightly: `REFRESH MATERIALIZED VIEW CONCURRENTLY supplier_capability_summary`

Until step 2 is built, the JSON is reference data only — but the scraper output shape is intentionally close to the production `awards` columns to make ingestion a straight mapping rather than a transform.

## Provenance

All sources are public open data:

- DR DGCP: https://data.open-contracting.org/en/publication/22 (OGL-3.0)
- GOJEP: https://www.gojep.gov.jm (public procurement records)
