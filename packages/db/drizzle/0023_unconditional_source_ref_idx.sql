-- Drop the partial WHERE on opp_source_ref_idx so ON CONFLICT can match
-- it. Postgres requires `ON CONFLICT (col, col) WHERE <pred>` to match
-- a partial unique index, and upsertOpportunity uses the simpler
-- `ON CONFLICT (col, col) DO NOTHING` form. Without this, every scraper
-- upsert errors with:
--   "there is no unique or exclusion constraint matching the ON CONFLICT
--    specification"
--
-- The partial-ness was introduced in 0021_uploaded_opportunities.sql to
-- "scope dedup to scraped rows only" — but uploaded rows have
-- jurisdiction_id IS NULL, and Postgres treats NULL values in unique
-- indexes as distinct by default. So an unconditional unique index on
-- (jurisdiction_id, source_reference_id) is just as safe for uploads:
-- multiple NULL-jurisdiction uploads don't collide.

DROP INDEX IF EXISTS "opp_source_ref_idx";
--> statement-breakpoint

CREATE UNIQUE INDEX "opp_source_ref_idx"
  ON "opportunities" ("jurisdiction_id", "source_reference_id");
