-- Schema gaps from buyer-intelligence-v2-free-sources-brief.md §3.1 + §3.3 —
-- the brief recommended fuel_type + signal_kind columns and a
-- buyer_consumption_estimate computed view; #414 shipped without them
-- because power-gen + mining were the first two sources and both fit
-- the simpler shape. Adding them now before EU MRV (Tier A #1) lands
-- with vessel-level fuel-type granularity that the chat assistant
-- needs to answer "who buys jet fuel" vs "who buys HFO".
--
-- All additive — IF NOT EXISTS / OR REPLACE — re-runs are idempotent.

ALTER TABLE fuel_consumption_signals
  ADD COLUMN IF NOT EXISTS fuel_type text;
--> statement-breakpoint

ALTER TABLE fuel_consumption_signals
  ADD COLUMN IF NOT EXISTS signal_kind text;
--> statement-breakpoint

-- Useful for "buyers of fuel-type X" queries from chat / discover.
CREATE INDEX IF NOT EXISTS fuel_consumption_signals_fuel_type_idx
  ON fuel_consumption_signals (fuel_type);
--> statement-breakpoint

-- Confidence-weighted aggregation across signals per entity. Brief §3.3
-- uses point estimates with low/high; our schema only stores ranges
-- (min/max), so the weighted volume uses the midpoint. Sources are
-- arrayed for provenance. Filters to last 36 months so stale signals
-- don't dominate.
--
-- Read pattern: chat tools / entity profile join this view onto
-- known_entities to surface a single calibrated bbl/yr estimate
-- instead of a list of raw signals.
CREATE OR REPLACE VIEW buyer_consumption_estimate AS
SELECT
  entity_slug,
  -- weighted midpoint, confidence-weighted across signals with both bounds
  SUM(
    ((volume_bbl_yr_min + volume_bbl_yr_max) / 2.0) * COALESCE(confidence, 0.5)
  ) FILTER (
    WHERE volume_bbl_yr_min IS NOT NULL
      AND volume_bbl_yr_max IS NOT NULL
  ) / NULLIF(
    SUM(COALESCE(confidence, 0.5)) FILTER (
      WHERE volume_bbl_yr_min IS NOT NULL
        AND volume_bbl_yr_max IS NOT NULL
    ),
    0
  ) AS weighted_volume_bbl_yr,
  MIN(volume_bbl_yr_min) AS volume_bbl_yr_min,
  MAX(volume_bbl_yr_max) AS volume_bbl_yr_max,
  COUNT(*) AS signal_count,
  ARRAY_AGG(DISTINCT source) AS sources,
  ARRAY_AGG(DISTINCT fuel_type) FILTER (WHERE fuel_type IS NOT NULL) AS fuel_types,
  MAX(as_of_date) AS most_recent_signal,
  AVG(confidence) AS avg_confidence
FROM fuel_consumption_signals
WHERE as_of_date >= CURRENT_DATE - INTERVAL '36 months'
GROUP BY entity_slug;
