-- Revenue Assumption Map (the "Counterfactual Deal Simulator") —
-- per docs/revenue-assumption-map.md (Cole's brief). Every fuel deal,
-- opportunity, lead, or counterparty org gets a small decision tree
-- of assumptions that need to be true for the relationship to become
-- revenue. Each assumption carries a confidence + the cheapest test
-- to confirm/disprove + the action type that test maps to.
--
-- Polymorphic on (subject_type, subject_id) so the same machinery
-- powers /deals/[id], /leads/[id], /opportunities/[slug], and entity
-- profiles. v1 only writes for fuel_deals; the column shape supports
-- the others without migration.
--
-- Idempotent — uses CREATE ... IF NOT EXISTS / ADD COLUMN IF NOT
-- EXISTS so a partial-failure replay is safe (Neon HTTP is auto-
-- commit per call).

DO $$ BEGIN
  CREATE TYPE assumption_type AS ENUM (
    'authority',
    'availability',
    'price',
    'payment',
    'compliance',
    'bankability',
    'logistics',
    'commercial_protection',
    'timing',
    'relationship_access'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint

DO $$ BEGIN
  CREATE TYPE assumption_status AS ENUM (
    'untested',
    'pending',
    'partial',
    'confirmed',
    'disproven'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS revenue_assumptions (
  id text PRIMARY KEY,
  subject_type text NOT NULL,
  subject_id text NOT NULL,
  assumption_type assumption_type NOT NULL,
  assumption_text text NOT NULL,
  /** 0..100 — operator-visible. Confidence the assumption is TRUE
      (i.e. the path-to-revenue is intact on this dimension). */
  confidence_score integer NOT NULL DEFAULT 50,
  status assumption_status NOT NULL DEFAULT 'untested',
  /** What we know that supports/contradicts the assumption — links to
      touchpoints, sanctions screens, customs lookups, web facts, etc. */
  evidence_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  /** One-sentence on what kills the deal if this assumption is false.
      Renders in the operator audit panel; never goes into outbound copy. */
  risk_if_false text,
  /** The cheapest test the operator can run to confirm or disprove —
      "ask procurement role", "request POP letter", "screen OFAC", etc. */
  fastest_test text,
  /** ActionDescriptor kind that the fastest_test maps to —
      'email.send' / 'sanctions.screen' / 'follow_up.schedule' /
      'crm.create_company' / null when no automated action fits. */
  recommended_action_type text,
  /** Set when status moves out of 'untested'. */
  tested_at timestamptz,
  /** Free-form operator-recorded result. Pairs with tested_at. */
  result text,
  /** Pointer back to the records that produced the result —
      approval id, touchpoint id, screen id, document id, etc. */
  result_evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  /** Pipeline version that generated this row — `gen-v1`, `gen-v2`,
      etc. Lets us regression-test changes to the LLM generator
      against historical assumption sets. */
  generator_version text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by text
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS revenue_assumptions_subject_idx
  ON revenue_assumptions (subject_type, subject_id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS revenue_assumptions_status_idx
  ON revenue_assumptions (status)
  WHERE status != 'confirmed';
