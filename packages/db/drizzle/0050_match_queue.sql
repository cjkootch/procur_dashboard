-- Proactive match queue.
--
-- Capstone of the strategic-vision.md loop: every morning, surface
-- a ranked queue of counterparty signals the trader should action
-- on. A "match" is the join of (signal source: distress event /
-- velocity drop / fresh award) × (relevance: category tag, country,
-- recency).
--
-- v1 ships a single global queue. Multi-user / per-trader interest
-- profiles come in a follow-up; today's queue is hardcoded to VTC's
-- lane (crude-oil + refined fuels, Caribbean + Med + LATAM).
--
-- Idempotent on (source_table, source_id) so the daily scoring job
-- can re-run without duplicating rows. Workflow state moves
-- forward only — once dismissed or pushed-to-vex a match doesn't
-- come back to 'open'.

CREATE TABLE match_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Signal classification.
  -- signal_type is the broad bucket; signal_kind is the specific
  -- event type from the source row (e.g. 'sec_filing_force_majeure',
  -- 'press_distress_signal', 'velocity_drop', 'new_award').
  signal_type text NOT NULL,
  signal_kind text NOT NULL,

  -- Source backref. Lets us re-fetch detail and dedupe re-scores.
  -- Tuple is unique-indexed so the daily job is safely re-runnable.
  source_table text NOT NULL,
  source_id text NOT NULL,

  -- Entity attribution. Both nullable — some signals (e.g. a
  -- press article) name an entity that's not yet in our rolodex
  -- or external_suppliers tables; we keep the source_entity_name
  -- verbatim so retroactive linking is possible.
  known_entity_id uuid REFERENCES known_entities(id) ON DELETE SET NULL,
  external_supplier_id uuid REFERENCES external_suppliers(id) ON DELETE SET NULL,
  source_entity_name text NOT NULL,
  source_entity_country text,

  -- Match-relevant context.
  category_tags text[],
  observed_at date NOT NULL,

  -- 0.00-9.99. Higher = more interesting. Job composes from
  -- relevance_score + recency bonus + signal-class baseline.
  score numeric(4, 2) NOT NULL,
  rationale text NOT NULL,

  -- Workflow state. 'open' is the default; status moves forward via
  -- the UI (dismiss / push-to-vex / actioned).
  status text NOT NULL DEFAULT 'open',
  status_updated_at timestamp with time zone NOT NULL DEFAULT NOW(),

  matched_at timestamp with time zone NOT NULL DEFAULT NOW(),
  created_at timestamp with time zone NOT NULL DEFAULT NOW()
);
--> statement-breakpoint

-- Hot query: what's open today, ranked by score?
CREATE INDEX match_queue_open_score_idx
  ON match_queue (status, score DESC, observed_at DESC);
--> statement-breakpoint

CREATE INDEX match_queue_observed_idx
  ON match_queue (observed_at DESC);
--> statement-breakpoint

-- Idempotency for the scoring job.
CREATE UNIQUE INDEX match_queue_dedup_idx
  ON match_queue (source_table, source_id);
