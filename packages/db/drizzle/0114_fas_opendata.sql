-- FAS Open Data connection: ESR weekly sales + country reference cache.
-- UN ComTrade annual data writes into the existing customs_imports
-- table with source='fas-un-comtrade' — no new table needed there.

CREATE TABLE IF NOT EXISTS fas_countries (
  -- FAS's own 2-char country code. NOT strictly ISO-2 (FAS uses
  -- legacy codes like CH=China, not Switzerland). Populated on
  -- ingest from /api/esr/countries + /api/gats/countries.
  fas_code         TEXT NOT NULL,
  -- Which FAS sub-API this code came from. ESR + GATS code spaces
  -- are documented as identical but we record provenance in case
  -- they diverge.
  api              TEXT NOT NULL, -- 'esr' | 'gats' | 'psd'
  country_name     TEXT NOT NULL,
  region_code      TEXT,
  -- Manually-curated ISO-2 mapping for the seed countries we
  -- actually ingest. Null for countries we don't have a mapping
  -- for yet — caller filters.
  iso2             TEXT,
  raw_payload      JSONB,
  ingested_at      TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMP NOT NULL DEFAULT NOW(),
  PRIMARY KEY (fas_code, api)
);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS fas_countries_iso2_idx
  ON fas_countries (iso2) WHERE iso2 IS NOT NULL;

--> statement-breakpoint

-- ESR weekly export commitments + outstanding + accumulated sales.
-- One row per (commodity_code, country_code, market_year, week_ending).
-- Source: https://api.fas.usda.gov/api/esr/exports/...
--
-- ESR is US-export-specific: reporter is always the US, partner is
-- `country_code`. We don't store reporter explicitly. Values are
-- physical units (varies per commodity — wheat in MT, soy oil in MT,
-- etc.) — uom_id is the FAS-published unit identifier.

CREATE TABLE IF NOT EXISTS fas_esr_weekly (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- FAS commodity code (e.g. 401 = wheat, 801 = soybeans). NOT HS.
  commodity_code          INTEGER NOT NULL,
  -- FAS country code (matches fas_countries.fas_code where api='esr').
  country_code            TEXT NOT NULL,
  -- FAS marketing year (e.g. 2025 for wheat covers Jun-2025 → May-2026).
  market_year             INTEGER NOT NULL,
  -- Sunday of the reporting week.
  week_ending_date        DATE NOT NULL,

  -- All numeric columns from the ESR record. Units per uom_id.
  weekly_exports                NUMERIC(20, 2),
  accumulated_exports_market_yr NUMERIC(20, 2),
  outstanding_sales             NUMERIC(20, 2),
  gross_new_sales               NUMERIC(20, 2),
  current_my_total_commitment   NUMERIC(20, 2),
  current_my_net_sales          NUMERIC(20, 2),
  next_my_outstanding_sales     NUMERIC(20, 2),
  next_my_net_sales             NUMERIC(20, 2),

  uom_id                  INTEGER,

  raw_payload             JSONB,
  ingested_at             TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMP NOT NULL DEFAULT NOW(),

  CONSTRAINT fas_esr_weekly_uniq
    UNIQUE (commodity_code, country_code, market_year, week_ending_date)
);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS fas_esr_weekly_country_commodity_idx
  ON fas_esr_weekly (country_code, commodity_code, week_ending_date DESC);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS fas_esr_weekly_week_ending_idx
  ON fas_esr_weekly (week_ending_date DESC);
