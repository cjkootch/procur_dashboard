-- Multilateral Development Bank (MDB) project archive — schema foundation.
-- Per docs/multilateral-bank-docs-brief.md §5. Two additive tables that mirror
-- the gain_reports + gain_importer_mentions shape so the LLM extraction
-- pipeline can be shared between GAIN and MDB sources.
--   1. mdb_projects — catalog of every observed MDB project; dedup + idempotency anchor for the per-bank scrapers
--   2. mdb_entity_mentions — extracted named-counterparty rows (filled by the Day 3 LLM stage)
-- Day 1 ships schema + IDB scraper only; CDB / World Bank / IFC are Days 2-3.

CREATE TABLE IF NOT EXISTS mdb_projects (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bank                     TEXT NOT NULL,
  external_id              TEXT NOT NULL,
  country_code             TEXT NOT NULL,
  project_name             TEXT NOT NULL,
  sector                   TEXT,
  status                   TEXT,
  approval_date            DATE,
  closing_date             DATE,
  total_amount_usd         NUMERIC(20, 2),
  source_url               TEXT NOT NULL,
  source_doc_url           TEXT,
  pdf_blob_url             TEXT,
  pdf_sha256               TEXT,
  pdf_page_count           INTEGER,
  extraction_status        TEXT NOT NULL DEFAULT 'pending',
  extraction_attempted_at  TIMESTAMP,
  extraction_completed_at  TIMESTAMP,
  extraction_error         TEXT,
  raw_metadata             JSONB,
  discovered_at            TIMESTAMP NOT NULL DEFAULT NOW(),
  created_at               TIMESTAMP NOT NULL DEFAULT NOW(),
  CONSTRAINT mdb_projects_bank_external_uniq UNIQUE (bank, external_id)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS mdb_projects_country_status_idx
  ON mdb_projects (country_code, status, approval_date DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS mdb_projects_pending_idx
  ON mdb_projects (extraction_status, discovered_at)
  WHERE extraction_status = 'pending';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS mdb_projects_bank_idx
  ON mdb_projects (bank, approval_date DESC);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS mdb_entity_mentions (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id               UUID NOT NULL REFERENCES mdb_projects(id) ON DELETE CASCADE,
  company_name             TEXT NOT NULL,
  company_name_normalized  TEXT NOT NULL,
  roles                    TEXT[] NOT NULL,
  sector                   TEXT,
  contract_value_usd       NUMERIC(20, 2),
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
CREATE INDEX IF NOT EXISTS mdb_entity_mentions_project_idx
  ON mdb_entity_mentions (project_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS mdb_entity_mentions_company_normalized_idx
  ON mdb_entity_mentions (company_name_normalized);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS mdb_entity_mentions_entity_idx
  ON mdb_entity_mentions (resolved_entity_id)
  WHERE resolved_entity_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS mdb_entity_mentions_unresolved_idx
  ON mdb_entity_mentions (resolved_entity_id)
  WHERE resolved_entity_id IS NULL;
