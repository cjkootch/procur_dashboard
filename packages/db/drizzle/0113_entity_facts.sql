-- Migration 0113: entity_facts — provenance-aware label store.
--
-- Phase 1 of the entity-cleanup architecture: one canonical store
-- for every fact about an entity (industry, company_role,
-- market_segment, product_category) tagged with its source,
-- confidence, evidence, and recorder. The flat known_entities.role
-- and known_entities.categories[] columns become read-paths over
-- the highest-authority active fact per type via the
-- current_entity_facts view.
--
-- Source-authority order baked into the view (highest to lowest):
--   human         operator confirmed via the review queue
--   operator_edit operator changed the field directly
--   website_crawl extracted from the entity's own website
--   apollo        third-party enrichment data
--   ingest        original seed data
--   model         classifier guess
--
-- Multiple sources can record different values for the same
-- (entity_slug, fact_type) — that's the whole point. The view
-- picks one for read paths; the others stay queryable for the
-- conflict-review surface in Phase 2.

CREATE TABLE IF NOT EXISTS entity_facts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_slug TEXT NOT NULL,
  fact_type TEXT NOT NULL,
  value TEXT NOT NULL,
  source TEXT NOT NULL,
  confidence NUMERIC(3, 2),
  evidence_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  recorded_by TEXT,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  superseded_at TIMESTAMPTZ,
  superseded_by UUID
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS entity_facts_entity_slug_idx
  ON entity_facts (entity_slug);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS entity_facts_type_value_idx
  ON entity_facts (fact_type, value);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS entity_facts_active_idx
  ON entity_facts (entity_slug, fact_type) WHERE superseded_at IS NULL;
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS entity_facts_dedupe_idx
  ON entity_facts (entity_slug, fact_type, value, source)
  WHERE superseded_at IS NULL;
--> statement-breakpoint

CREATE OR REPLACE VIEW current_entity_facts AS
SELECT DISTINCT ON (entity_slug, fact_type)
  id,
  entity_slug,
  fact_type,
  value,
  source,
  confidence,
  evidence_json,
  recorded_by,
  recorded_at
FROM entity_facts
WHERE superseded_at IS NULL
ORDER BY
  entity_slug,
  fact_type,
  CASE source
    WHEN 'human' THEN 1
    WHEN 'operator_edit' THEN 2
    WHEN 'website_crawl' THEN 3
    WHEN 'apollo' THEN 4
    WHEN 'ingest' THEN 5
    WHEN 'model' THEN 6
    ELSE 99
  END,
  confidence DESC NULLS LAST,
  recorded_at DESC;
