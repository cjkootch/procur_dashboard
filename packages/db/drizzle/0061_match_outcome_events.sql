-- Match-outcome event log — append-only stream of vex's reports
-- about the lifecycle of fuel_deals that originated from procur leads.
--
-- Vex calls POST /api/intelligence/match-outcome with:
--   { procur_opportunity_id, outcome, vex_deal_id?, vex_deal_ref?,
--     outcome_note?, reported_at, source: "vex" }
--
-- Same opportunity legitimately produces multiple events
-- (created → closed_won, or created → closed_lost). Each event lands
-- as a row, keyed on (procur_opportunity_id, outcome) so a duplicate
-- post is a noop, not an error. Vex generates the events on
-- transition; we record them.
--
-- Distinct from `match_queue.deal_outcome` (which holds the LATEST
-- terminal outcome for the operator UI). This table is the canonical
-- history; the match_queue column is a denormalization for the
-- read-path. The endpoint updates both.
--
-- Brief context: docs/data-graph-connections-brief.md §4 was
-- procur-side; #309 is vex's matching shipment.

CREATE TABLE IF NOT EXISTS match_outcome_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- The opaque ID procur originally sent vex on /ingest/procur/leads
  -- as `procurOpportunityId` (== sourceRef on the procur push;
  -- typically `match-queue:<uuid>` or `match-queue:<uuid>:<slug>`).
  -- Treated as text — vex echoes it back verbatim.
  procur_opportunity_id text NOT NULL,

  -- 'created' | 'closed_won' | 'closed_lost' | 'no_engagement'.
  -- Validated at the route layer; left as text here so future enum
  -- additions don't need a migration.
  outcome text NOT NULL,

  -- Vex's IDs — ULID + human-readable ref. Set on outcome='created'
  -- and echoed on subsequent terminal outcomes.
  vex_deal_id text,
  vex_deal_ref text,

  -- Operator's transition rationale, free text. NULL when vex
  -- didn't capture one.
  outcome_note text,

  -- When vex observed the transition. Distinct from `created_at`
  -- (which is when we received the webhook).
  reported_at timestamp with time zone NOT NULL,

  -- Provenance. 'vex' today; reserved for future emitters.
  source text NOT NULL DEFAULT 'vex',

  created_at timestamp with time zone NOT NULL DEFAULT NOW()
);
--> statement-breakpoint

-- Idempotency / replay key. Re-posting the same (opportunity, outcome)
-- pair is a noop via ON CONFLICT DO NOTHING.
CREATE UNIQUE INDEX IF NOT EXISTS match_outcome_events_dedup_idx
  ON match_outcome_events (procur_opportunity_id, outcome);
--> statement-breakpoint

-- Lookup-by-opportunity for "show me the lifecycle of this lead".
CREATE INDEX IF NOT EXISTS match_outcome_events_opportunity_idx
  ON match_outcome_events (procur_opportunity_id, reported_at DESC);
--> statement-breakpoint

-- Time-ordered scan for the analytics view's window aggregations.
CREATE INDEX IF NOT EXISTS match_outcome_events_reported_at_idx
  ON match_outcome_events (reported_at DESC);
--> statement-breakpoint

-- Lookup-by-vex-deal-id when vex re-posts an outcome and only has
-- the deal id handy (rare, but the route supports both lookup paths).
CREATE INDEX IF NOT EXISTS match_outcome_events_vex_deal_id_idx
  ON match_outcome_events (vex_deal_id)
  WHERE vex_deal_id IS NOT NULL;
