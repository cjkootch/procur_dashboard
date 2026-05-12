-- USDA FAS GAIN Report Extraction — schema foundation.
-- Per docs/gain-extraction-brief.md §5. Two additive tables:
--   1. gain_reports — catalog of every observed GAIN report; dedup + idempotency anchor for the scraper
--   2. gain_importer_mentions — extracted named-importer rows (filled by the LLM stage on Day 3)
-- This migration ships Day-1 schema only; the extraction columns are
-- defaulted/nullable so the scraper can land rows before the extractor exists.

CREATE TABLE IF NOT EXISTS gain_reports (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id               TEXT,
  country_code            TEXT NOT NULL,
  post_city               TEXT,
  report_type             TEXT NOT NULL,
  title                   TEXT NOT NULL,
  publication_date        DATE,
  source_filename         TEXT NOT NULL,
  source_url              TEXT NOT NULL,
  pdf_blob_url            TEXT,
  pdf_sha256              TEXT,
  pdf_page_count          INTEGER,
  extraction_status       TEXT NOT NULL DEFAULT 'pending',
  extraction_attempted_at TIMESTAMP,
  extraction_completed_at TIMESTAMP,
  extraction_error        TEXT,
  raw_metadata            JSONB,
  discovered_at           TIMESTAMP NOT NULL DEFAULT NOW(),
  created_at              TIMESTAMP NOT NULL DEFAULT NOW(),
  CONSTRAINT gain_reports_source_filename_uniq UNIQUE (source_filename)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS gain_reports_country_date_idx
  ON gain_reports (country_code, publication_date DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS gain_reports_pending_idx
  ON gain_reports (extraction_status, discovered_at)
  WHERE extraction_status = 'pending';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS gain_importer_mentions (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id                UUID NOT NULL REFERENCES gain_reports(id) ON DELETE CASCADE,
  company_name             TEXT NOT NULL,
  company_name_normalized  TEXT NOT NULL,
  roles                    TEXT[] NOT NULL,
  commodity_categories     TEXT[] NOT NULL,
  market_position          TEXT,
  supply_preferences       TEXT[],
  context_excerpt          TEXT NOT NULL,
  source_section           TEXT,
  source_page              INTEGER,
  extraction_confidence    NUMERIC(3, 2) NOT NULL CHECK (extraction_confidence BETWEEN 0 AND 1),
  validator_grade          TEXT,
  resolved_entity_id       TEXT,
  resolution_confidence    NUMERIC(3, 2),
  resolution_method        TEXT,
  extracted_at             TIMESTAMP NOT NULL DEFAULT NOW(),
  created_at               TIMESTAMP NOT NULL DEFAULT NOW()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS gain_importer_mentions_report_idx
  ON gain_importer_mentions (report_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS gain_importer_mentions_company_normalized_idx
  ON gain_importer_mentions (company_name_normalized);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS gain_importer_mentions_entity_idx
  ON gain_importer_mentions (resolved_entity_id)
  WHERE resolved_entity_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS gain_importer_mentions_unresolved_idx
  ON gain_importer_mentions (resolved_entity_id)
  WHERE resolved_entity_id IS NULL;
