-- Phase 2D of Market Probes: discipline layer.
--
-- Four changes that turn a probe from "outbound activity" into a
-- falsifiable experiment:
--
-- 1. market_probe_hypotheses — explicit pre-hoc commitments. The
--    plan-gen agent emits 3-7; operator edits. Each hypothesis has
--    a test method, a starting confidence, a current confidence
--    (decays/rises with evidence), and a final result.
--
-- 2. market_probe_targets gains justification columns + the
--    research-only promotion bar. Targets without enough
--    justification stay research_only — they don't show up in
--    Tier 1 autopilot's draftable queue (Phase 2H).
--
-- 3. market_atlas_facts gains rule_text — turns the descriptive
--    "this segment doesn't reply" into the prescriptive "never
--    target this segment without X qualifier." Pairs with new
--    fact_type='negative_rule'. Stays in atlas (rather than a
--    separate table) for cross-probe persistence + supersession
--    parity with the rest of market memory.
--
-- 4. market_probes.ladder_stage — 5-stage enum. New probes start
--    at market_structure; agent emits proposed advances; operator
--    approves. Hard gate: agent cannot skip ahead to
--    commercial_qualification or deal_room_conversion without
--    evidence from earlier stages. Enforced by validation in the
--    advance-stage action — schema just stores.

CREATE TABLE IF NOT EXISTS market_probe_hypotheses (
  id text PRIMARY KEY,
  probe_id text NOT NULL REFERENCES market_probes(id) ON DELETE CASCADE,

  -- Free text — canonical kinds:
  --   target_segment        — "Hotels are the right buyer cluster"
  --   contact_title         — "Procurement managers respond more than ops"
  --   message_angle         — "Routing-style ('are you the right person?')
  --                            beats supplier-intro"
  --   signal_quality        — "Cold storage ownership predicts food-supply
  --                            interest"
  --   market_demand         — "There's enough imported food volume here
  --                            to justify a desk relationship"
  hypothesis_type text NOT NULL,

  -- The hypothesis as a falsifiable statement.
  statement text NOT NULL,

  -- Confidence scale 0-1. Start = what the agent / operator believed
  -- before testing. Current = updated as evidence rolls in. Result is
  -- the final call once the probe ends or the hypothesis is
  -- explicitly resolved.
  confidence_start numeric NOT NULL DEFAULT 0.5,
  confidence_current numeric NOT NULL DEFAULT 0.5,

  -- How we'll know if the hypothesis holds. Free text — agent
  -- emits, operator edits. Examples:
  --   "Reply rate from hotels > 20% over 10 sends"
  --   "At least 3 named procurement contacts found"
  test_method text,

  -- 'active' | 'confirmed' | 'falsified' | 'unclear' | 'abandoned'
  status text NOT NULL DEFAULT 'active',

  -- Final operator + agent take. Populated when status moves off
  -- 'active'. Used by the end-of-probe Learning Report (Phase 2F)
  -- as the "what we believed at start vs what changed" diff.
  result text,

  -- Per-hypothesis evidence trail. The agent appends here when
  -- updating confidence; operator appends inline notes. Shape:
  --   [{ at: ISO, source: 'agent'|'operator', confidence: 0-1,
  --      note: text, evidence: { ... raw signal ... } }]
  evidence_json jsonb NOT NULL DEFAULT '[]'::jsonb,

  authored_by text NOT NULL DEFAULT 'agent',
  created_by_user_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS market_probe_hypotheses_probe_idx
  ON market_probe_hypotheses(probe_id);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS market_probe_hypotheses_status_idx
  ON market_probe_hypotheses(status);

--> statement-breakpoint

-- Target justification columns. Nullable so existing targets
-- (Phase 1A/2A/2B) stay valid; new targets land with these populated
-- (or stay in send_status='pending' / research_only until they are).
ALTER TABLE market_probe_targets
  ADD COLUMN IF NOT EXISTS why_this_company text;

--> statement-breakpoint

ALTER TABLE market_probe_targets
  ADD COLUMN IF NOT EXISTS why_this_person text;

--> statement-breakpoint

ALTER TABLE market_probe_targets
  ADD COLUMN IF NOT EXISTS why_now text;

--> statement-breakpoint

ALTER TABLE market_probe_targets
  ADD COLUMN IF NOT EXISTS supporting_signals jsonb NOT NULL DEFAULT '[]'::jsonb;

--> statement-breakpoint

ALTER TABLE market_probe_targets
  ADD COLUMN IF NOT EXISTS safest_first_ask text;

--> statement-breakpoint

-- Promotion gate: targets without justification stay 'research_only'.
-- Phase 2H autopilot reads this column when building the daily-send
-- queue — research_only targets are never auto-drafted/sent.
-- Existing rows default to 'pending' (not research_only) for
-- backwards compat — operators can grandfather them in.
ALTER TABLE market_probe_targets
  ADD COLUMN IF NOT EXISTS justification_state text NOT NULL DEFAULT 'pending';

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS market_probe_targets_justification_state_idx
  ON market_probe_targets(probe_id, justification_state);

--> statement-breakpoint

-- Atlas extension: rule_text turns descriptive facts into
-- prescriptive behavioral rules. Pairs with new fact_type='negative_rule'.
-- Optional on every fact (only negative_rule + procurement_pattern
-- typically use it).
ALTER TABLE market_atlas_facts
  ADD COLUMN IF NOT EXISTS rule_text text;

--> statement-breakpoint

-- Probe ladder stage. 5 stages, sequential. Default 'market_structure'
-- for new probes; existing probes get the same default (they're all
-- early-stage by definition since send paths haven't shipped).
ALTER TABLE market_probes
  ADD COLUMN IF NOT EXISTS ladder_stage text NOT NULL DEFAULT 'market_structure';

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS market_probes_ladder_stage_idx
  ON market_probes(ladder_stage);
