-- Phase 2G of Market Probes: safety net.
--
-- Three changes that make Tier 1 autopilot (Phase 2H) safe to ship:
--
-- 1. market_probes.mode — 'experiment' (default for Probes) vs
--    'relationship' (for strategic-account probes that need higher
--    discipline). Tier 1 autopilot only fires for mode='experiment'.
--
-- 2. known_entities.scout_protection — entities flagged as off-
--    limits to autonomous scouting. Strategic relationships, sensitive
--    counterparties, or entities the operator wants to keep manual.
--    All probe target-discovery paths (graph recommender, Apollo
--    lookalikes, Apollo thesis search) filter these out.
--
-- 3. market_probes kill-criteria columns — operator-set thresholds
--    that trigger auto-pause when scorecard reads breach them. Phase
--    2H's autopilot calls checkProbeKillCriteria() before every
--    send-batch and pauses the probe with a reason if any threshold
--    is exceeded.

ALTER TABLE market_probes
  ADD COLUMN IF NOT EXISTS mode text NOT NULL DEFAULT 'experiment';

--> statement-breakpoint

ALTER TABLE market_probes
  ADD COLUMN IF NOT EXISTS max_bounce_rate_pct numeric NOT NULL DEFAULT 8;

--> statement-breakpoint

ALTER TABLE market_probes
  ADD COLUMN IF NOT EXISTS max_complaint_rate_pct numeric NOT NULL DEFAULT 1;

--> statement-breakpoint

-- "If we've sent N targets in a segment with no replies, auto-pause
--  that segment." The autopilot will use this to stop wasting sends
--  on a segment that's not signaling.
ALTER TABLE market_probes
  ADD COLUMN IF NOT EXISTS max_no_reply_before_segment_pause integer NOT NULL DEFAULT 12;

--> statement-breakpoint

-- "If we've sent N total with no positive signal, auto-pause the
--  whole probe." Hard ceiling so a misjudged probe doesn't burn
--  through the entire send budget.
ALTER TABLE market_probes
  ADD COLUMN IF NOT EXISTS max_total_no_signal_before_probe_pause integer NOT NULL DEFAULT 30;

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS market_probes_mode_idx
  ON market_probes(mode);

--> statement-breakpoint

-- known_entities scout_protection. Default false; operator opts in
-- per entity from the entity-profile page. Indexed because every
-- target-discovery path filters on `scout_protection = false`.
ALTER TABLE known_entities
  ADD COLUMN IF NOT EXISTS scout_protection boolean NOT NULL DEFAULT false;

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS known_entities_scout_protection_idx
  ON known_entities(scout_protection)
  WHERE scout_protection = true;
