-- Adds a state / province column to known_entities.
--
-- Use case: logistics. Most US fuel + grain entities cluster by
-- region, and freight cost diverges sharply between e.g. Iowa
-- (Midwest grain origination) vs Texas (Gulf refineries). The
-- existing country column collapses all 50 US states into one
-- bucket — too coarse for routing or rate-pulling.
--
-- Format: 2-letter postal / ISO-3166-2 alpha-2 subdivision code
-- (US: 'IA', 'TX'; Canada: 'ON', 'BC'). Nullable — most non-US,
-- non-Canada entities don't have a clean subdivision concept and
-- stay null. Index is partial so the bulk of null-state rows
-- don't bloat the index.

ALTER TABLE known_entities
  ADD COLUMN IF NOT EXISTS state TEXT;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS known_entities_state_idx
  ON known_entities (state)
  WHERE state IS NOT NULL;
