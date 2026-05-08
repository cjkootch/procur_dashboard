-- Phase 2C of Market Probes: market memory + strategy adaptation.
--
-- Two new tables that turn the probe from a one-shot outbound run
-- into a learning system:
--
-- 1. market_atlas_facts — a "private market atlas." Every fact a
--    probe surfaces about a market's STRUCTURE (who's the gatekeeper,
--    who's a dead end, who refers to whom, which signals mattered)
--    lands here. Operators write facts inline; the agent writes facts
--    as it observes patterns. Facts persist across probes — this is
--    the cross-probe memory that's missing today.
--
-- 2. market_probe_strategy_proposals — agent-proposed plan changes
--    that need operator approval. Approved proposals modify
--    probe.plan_json + advance task; rejected proposals carry forward
--    as constraints into the next plan-generation pass ("operator
--    rejected pivoting to hotels last time"). Both directions are
--    feedback signal.

CREATE TABLE IF NOT EXISTS market_atlas_facts (
  id text PRIMARY KEY,

  -- ISO-2 country (or 'XX' for cross-border facts). Indexed —
  -- /market-atlas/[country] reads via this column.
  country text NOT NULL,
  -- Optional segment scope ("hotel procurement", "fuel distributor").
  -- NULL = market-wide fact.
  segment text,

  -- Polymorphic anchor — facts can be ABOUT a known_entity or about
  -- the relationship BETWEEN two entities. entity_slug + related_slug.
  -- entity_slug references known_entities.slug or external_suppliers.id
  -- as text, mirroring the supplier_approvals + market_probe_targets
  -- pattern. Either may be null for market-level facts (e.g. "this
  -- market has no online procurement infrastructure" — no entity
  -- anchor).
  entity_slug text,
  related_entity_slug text,

  -- Fact taxonomy. Free text so we can add types additively without
  -- migrations; canonical values:
  --   gatekeeper            — controls access to a downstream entity
  --   bottleneck            — slow / understaffed / unresponsive
  --   dead_end              — confirmed not buying / out of market
  --   referral              — entity_slug referred us to related_slug
  --   relationship          — entity_slug ↔ related_slug (vague tie)
  --   signal_mattered       — a specific signal predicted activity
  --   signal_noise          — a signal we thought mattered didn't
  --   assumption_wrong      — operator/agent hypothesis that didn't pan
  --   procurement_pattern   — how this market actually buys
  --   compliance_note       — KYC / sanctions / payment quirks
  fact_type text NOT NULL,

  -- Free-text description. The atlas surface renders this as the
  -- human-readable line ("Vitol Caribbean handles all USVI fuel
  -- procurement; reps direct queries to ops@vitol-caribbean.com").
  description text NOT NULL,

  -- Source pointers — what observation produced this fact. probe id,
  -- target id, event id (touchpoint, reply). All optional; an
  -- operator can write a manual fact with no source.
  source_probe_id text,
  source_target_id text,
  source_event_id text,

  -- Who wrote it: 'operator' | 'agent'. Agent-written facts are
  -- proposals operators can correct via the atlas UI's edit-in-place.
  authored_by text NOT NULL DEFAULT 'operator',

  -- 0-1. Operator-written facts default 0.9; agent-written start at
  -- 0.5 and rise as repeated probes corroborate.
  confidence numeric NOT NULL DEFAULT 0.9,

  -- Append-only revisions. When understanding improves, mark the old
  -- fact superseded_by the new one rather than mutating in place.
  -- Cross-probe queries filter superseded_by IS NULL by default.
  superseded_by text REFERENCES market_atlas_facts(id) ON DELETE SET NULL,

  created_by_user_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS market_atlas_facts_country_idx
  ON market_atlas_facts(country);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS market_atlas_facts_country_segment_idx
  ON market_atlas_facts(country, segment);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS market_atlas_facts_entity_idx
  ON market_atlas_facts(entity_slug);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS market_atlas_facts_probe_idx
  ON market_atlas_facts(source_probe_id);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS market_atlas_facts_active_idx
  ON market_atlas_facts(country, fact_type)
  WHERE superseded_by IS NULL;

--> statement-breakpoint

CREATE TABLE IF NOT EXISTS market_probe_strategy_proposals (
  id text PRIMARY KEY,
  probe_id text NOT NULL REFERENCES market_probes(id) ON DELETE CASCADE,

  -- Proposal taxonomy:
  --   shift_segment        — pause segment X, prioritize segment Y
  --   add_segment          — add segment Z to allowed_segments
  --   pause_segment        — stop targeting segment X
  --   change_template      — swap first-touch template
  --   tighten_targeting    — raise fit_tier threshold for sends
  --   loosen_targeting     — lower fit_tier threshold
  --   shift_titles         — prioritize different decision-maker titles
  --   pause_probe          — recommend operator pause (signal too weak)
  --   complete_probe       — recommend operator complete (objective met)
  proposal_type text NOT NULL,

  -- Free-text rationale the agent generates. Operator reads this to
  -- decide approve/reject. Sonnet-grounded; should reference
  -- specific metrics ("18 sent, 0 replies; pivot recommended").
  rationale text NOT NULL,

  -- Structured payload describing the change. Shape varies by
  -- proposal_type but always carries a `before`/`after` snapshot of
  -- the affected fields so the diff is rendered cleanly in the UI.
  -- Examples:
  --   { "before": { "segments": ["hotel", "fuel"] },
  --     "after":  { "segments": ["hotel", "marine_ops"] } }
  --   { "before": { "templateRef": "routing_v1" },
  --     "after":  { "templateRef": "supplier_intro_v2" } }
  payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- Evidence the agent built the proposal from — metric snapshot at
  -- proposal time. Lets operator inspect WHY the agent thought this.
  -- { sent: 18, replied: 0, bounced: 2, segments_breakdown: {...} }
  evidence_json jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- proposed | approved | rejected | superseded
  status text NOT NULL DEFAULT 'proposed',

  -- Operator feedback when rejecting. Rides into the NEXT
  -- plan-generation pass as a constraint ("operator rejected pivot
  -- to marine ops; reason: 'we don't have any marine relationships
  -- yet'"). Crucial for the system to LEARN from rejections, not
  -- just accept-or-bury.
  reviewer_feedback text,

  reviewed_at timestamptz,
  reviewed_by_user_id text,
  applied_at timestamptz,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS market_probe_strategy_proposals_probe_idx
  ON market_probe_strategy_proposals(probe_id);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS market_probe_strategy_proposals_status_idx
  ON market_probe_strategy_proposals(status);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS market_probe_strategy_proposals_probe_status_idx
  ON market_probe_strategy_proposals(probe_id, status);
