-- USDA FSIS Meat, Poultry and Egg Product Inspection Directory (MPI Directory).
--
-- Every federally-inspected meat / poultry / egg facility in the US — i.e. the
-- regulatory universe of suppliers legally allowed to slaughter or process for
-- interstate commerce / export. Source: FSIS publishes a CSV quarterly at
-- fsis.usda.gov/inspection/establishments/meat-poultry-and-egg-product-inspection-directory
--
-- This is the "named US supplier" complement to FAS ESR weekly export data
-- (which only names destination country, not source facility). When FAS says
-- "US shipped X MT of pork to Dominican Republic in Q1", MPI tells us WHICH
-- 600-1000 hog/swine establishments could legally be the origin.
--
-- Establishment numbers ("M-12345", "P-2580", "EST 38N") are stable and serve
-- as the primary key — they're FSIS's own permanent identifier for each row.

CREATE TABLE IF NOT EXISTS usda_fsis_establishments (
  establishment_number TEXT PRIMARY KEY,
  legal_name           TEXT NOT NULL,
  dba_name             TEXT,
  street               TEXT,
  city                 TEXT,
  state                TEXT,
  zip                  TEXT,
  county               TEXT,
  phone                TEXT,
  -- Multi-valued: ['slaughter', 'processing', 'plant', 'import', 'identification']
  activities           TEXT[] NOT NULL DEFAULT '{}',
  -- Multi-valued: ['swine', 'cattle', 'sheep', 'goat', 'equine', 'poultry', 'egg']
  species              TEXT[] NOT NULL DEFAULT '{}',
  -- Inspection grants: ['federal', 'state', 'talmadge-aiken']
  grants               TEXT[] NOT NULL DEFAULT '{}',
  -- Coordinates when published in the directory (NULL otherwise; map fallback
  -- via lib/known-entity-centroids covers US state-level positioning).
  latitude             NUMERIC(10, 7),
  longitude            NUMERIC(10, 7),
  raw_payload          JSONB,
  -- ── Enrichment columns (filled by side-effects after ingest) ───────────
  -- Apollo linkage gives us employees / revenue band / website / industry
  -- without re-querying Apollo per chat turn. Filled by enrichOrgsBatch
  -- on the legal_name → domain match (best-effort; null when Apollo has
  -- no record, which is common for smaller regional processors).
  apollo_org_id        TEXT,
  apollo_synced_at     TIMESTAMP,
  estimated_employees  INTEGER,
  annual_revenue_usd   BIGINT,
  website_url          TEXT,
  primary_domain       TEXT,
  industry             TEXT,
  short_description    TEXT,
  -- Operations + capacity signals (filled by USDA AMS Livestock Slaughter
  -- ingest in a follow-up — see PR description). Captured at this layer
  -- so the chat tool can return a single denormalized row per facility.
  capacity_head_per_day INTEGER,
  capacity_source       TEXT,                 -- 'ams' | 'website' | 'operator'
  -- Product / cut detail surfaces from website-intelligence crawls
  -- (entity_web_summaries) joined back here on primary_domain match.
  -- Populated by a follow-up Apollo + crawl pipeline.
  product_summary      TEXT,
  product_summary_source TEXT,                -- 'website-intel' | 'gain' | 'operator'
  ingested_at          TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMP NOT NULL DEFAULT NOW()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS usda_fsis_establishments_species_gin_idx
  ON usda_fsis_establishments USING GIN (species);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS usda_fsis_establishments_activities_gin_idx
  ON usda_fsis_establishments USING GIN (activities);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS usda_fsis_establishments_state_idx
  ON usda_fsis_establishments (state);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS usda_fsis_establishments_legal_name_trgm_idx
  ON usda_fsis_establishments USING GIN (legal_name gin_trgm_ops);
