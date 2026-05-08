-- Compartmentalization tag for known_entities.
--
-- Probes are experimental — operators run them across very different
-- domains (fuel procurement, cross-border M&A matchmaking, succession
-- targets, food distribution). Today probe target discovery
-- (Apollo lookalikes, thesis-driven org search) inserts stub
-- known_entities rows with role='unknown', categories=[], no probe
-- linkage, no domain tag. The fuel rolodex would surface these in
-- any country=JP query — and worse, the GraphSAGE retraining + BGE
-- embedding pipelines would silently mix the domains.
--
-- This column stamps the discovery domain at stub-creation time:
--   NULL              — hand-curated / fuel-era. The gold rolodex.
--                       Untouched by this migration; existing rows
--                       stay null.
--   'fuel_supply'     — fuel-procurement probe
--   'ma_matchmaking'  — cross-border M&A probe
--   'pe_buyers'       — PE-target sourcing
--   ...               — operator-defined per probe
--
-- lookupKnownEntities will filter on this when callers request a
-- specific domain scope (default: all). Fuel-side chat tools
-- can pass discovery_domain IN (NULL, 'fuel_supply') to exclude
-- M&A stubs from candidate lists.
--
-- Operator can promote a stub to the gold rolodex by setting
-- discovery_domain back to NULL via the entity profile UI.
--
-- Idempotent + nullable. No backfill — existing entities stay null
-- (which is correct: they ARE the gold rolodex). Partial index keeps
-- query plans unchanged for null-domain rows.

ALTER TABLE known_entities
  ADD COLUMN IF NOT EXISTS discovery_domain text;

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS known_entities_discovery_domain_idx
  ON known_entities (discovery_domain)
  WHERE discovery_domain IS NOT NULL;
