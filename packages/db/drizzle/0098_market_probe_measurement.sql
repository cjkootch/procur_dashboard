-- Phase 2E of Market Probes: measurement layer.
--
-- Two changes that turn raw activity into actionable signal:
--
-- 1. market_map_segments — per-(probe, segment) coverage tracking.
--    Operator (or the agent) sets an estimatedTotal for each segment
--    in the probe; identifiedCount + contactedCount + repliedCount
--    auto-aggregate from market_probe_targets. UI surfaces "we've
--    contacted 8 of an estimated 35 hotels in Barbados — 23%
--    coverage" so the operator can see when a segment is well-covered
--    vs. when there's still surface area.
--
-- 2. signals_present (jsonb) on market_probe_targets — structured
--    boolean flags per the buyer-intelligence taxonomy:
--      procurement_email_found, named_contact_found,
--      imports_relevant_products, cold_storage,
--      serves_hotels_restaurants, active_website, apollo_contact,
--      recent_hiring, tender_or_procurement_signal
--    Joined against reply outcomes by the scorecard helper to compute
--    signal validation — "did the cold_storage signal predict reply?
--    9 sent with cold_storage, 4 replies; 12 without, 1 reply.
--    Likely real signal."
--
-- Feedback shortcuts (item 11) ride on the existing feedback_events
-- table — no schema change needed; UI exposes one-click buttons that
-- write feedback_kind='match_quality'/'disposition' rows.
--
-- Probe scorecard (item 8) computes on demand — no new table; reads
-- from market_probe_targets + feedback_events + market_atlas_facts +
-- market_probe_hypotheses + market_map_segments and synthesizes.

CREATE TABLE IF NOT EXISTS market_map_segments (
  id text PRIMARY KEY,
  probe_id text NOT NULL REFERENCES market_probes(id) ON DELETE CASCADE,

  segment_name text NOT NULL,

  -- Operator's (or agent's) estimate of how many real companies fit
  -- this segment in the probe's market. Drives the % coverage metric.
  -- Optional — when null, coverage is just absolute counts.
  estimated_total integer,

  -- Aggregates kept fresh via writes below + a refresh helper. Not
  -- maintained as triggers (Postgres triggers on app tables would
  -- conflict with the rest of the codebase's pattern of computing
  -- in catalog helpers).
  identified_count integer NOT NULL DEFAULT 0,
  contacted_count integer NOT NULL DEFAULT 0,
  replied_count integer NOT NULL DEFAULT 0,

  notes text,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS market_map_segments_probe_idx
  ON market_map_segments(probe_id);

--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS market_map_segments_probe_segment_uniq
  ON market_map_segments(probe_id, segment_name);

--> statement-breakpoint

-- Signal attribution. Structured boolean flags per target. Joined
-- against reply outcomes by the scorecard helper.
ALTER TABLE market_probe_targets
  ADD COLUMN IF NOT EXISTS signals_present jsonb NOT NULL DEFAULT '{}'::jsonb;
