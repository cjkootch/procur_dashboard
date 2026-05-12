# GAIN reference samples

Text-extracted USDA FAS Global Agricultural Information Network (GAIN) reports held in the repo as validation targets for the extraction pipeline specified in docs/gain-extraction-brief.md.

## Purpose

These files are NOT operational data. They are static reference artifacts the dev team uses to:

1. Validate the LLM extraction prompt against ground truth.
2. Reconcile FAS Open Data numbers against narrative reports.
3. Provide context for Caribbean basin food-trade work.

## Naming convention

{REPORT_ID}_{Slug-Of-Report-Title}.md for example VE2026-0002_US-Venezuelan-Agricultural-Trade-Summary-2025.md.

## Coverage

| Report ID | Country | Type | Notes |
|---|---|---|---|
| VE2026-0002 | Venezuela | Market summary | Negative-case validation: no named importers; macro statistics only |

Steady-state target: 10-15 samples covering the high-yield report types across the seed country list.

## Source attribution

All source material is public-domain USDA FAS reporting. The canonical URL is preserved on every sample.
