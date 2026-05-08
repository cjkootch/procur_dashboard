-- Per-probe domain tag.
--
-- Free-text identifier for the kind of bet this probe is testing —
-- e.g. 'fuel_supply', 'ma_matchmaking', 'pe_buyers',
-- 'succession_targets', 'food_distribution'. Operator-defined slug;
-- the system doesn't enforce a vocabulary, but stable values let
-- cross-probe memory filter sensibly.
--
-- Used by listRecentLearningReportsByCountry: today the cross-probe
-- memory join is country-only, which means a Japan fuel probe's
-- learning report would feed into a Japan M&A probe's strategy-agent
-- prompt. With this column the memory query AND-filters on matching
-- domain when the current probe has one set, and falls back to the
-- country-only join when the column is null (back-compat).
--
-- Idempotent: ADD COLUMN IF NOT EXISTS so re-runs after partial
-- failure are safe. No backfill — existing probes have null domain
-- and continue to see all in-country reports until an operator
-- explicitly tags them.

ALTER TABLE market_probes
  ADD COLUMN IF NOT EXISTS domain text;

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS market_probes_domain_idx
  ON market_probes (domain)
  WHERE domain IS NOT NULL;
