-- Phase 2F of Market Probes: synthesis layer.
--
-- Two new tables that turn the probe's accumulated learning into
-- reusable outputs:
--
-- 1. market_playbooks — versioned, reusable templates. A probe that
--    confirmed "Caribbean food importers" can save itself as a
--    playbook; the next probe in Bahamas / Jamaica / Cayman starts
--    from that playbook (pre-filled segments, hypotheses, outreach
--    angle, contact titles, compliance notes).
--    parent_playbook_id self-FK enables versioning — v2 forks from
--    v1 and supersedes it. Operator promotes a draft playbook to
--    active when ready.
--
-- 2. market_probe_learning_reports — end-of-probe Sonnet synthesis.
--    Reads scorecard + atlas + hypotheses + feedback + segments and
--    emits "what we believed at start vs what changed, what worked,
--    what failed, best segment, worst segment, best contact title,
--    strongest signal, noisy signals, bad-target rules, recommended
--    next probe, playbook updates."
--
--    Stored as a row (not just generated transiently) so the
--    operator can re-read past reports + so the playbook generator
--    can read the report's nominations.

CREATE TABLE IF NOT EXISTS market_playbooks (
  id text PRIMARY KEY,
  name text NOT NULL,
  description text,

  -- ISO-2 country codes the playbook is meant to apply to. Empty
  -- array = market-agnostic. Fork-from-playbook UI filters by
  -- intersection with the new probe's country.
  applicable_countries text[] NOT NULL DEFAULT ARRAY[]::text[],

  -- Recommended / avoided segments learned from the source probe(s).
  recommended_segments text[] NOT NULL DEFAULT ARRAY[]::text[],
  avoided_segments text[] NOT NULL DEFAULT ARRAY[]::text[],

  -- Decision-maker title patterns learned. "VP of Supply", "Director
  -- of Procurement" — what worked AND what didn't.
  best_contact_titles text[] NOT NULL DEFAULT ARRAY[]::text[],
  avoided_contact_titles text[] NOT NULL DEFAULT ARRAY[]::text[],

  -- Hypotheses pre-seeded for new probes forked from this playbook.
  -- Shape mirrors the plan-gen agent's ProposedHypothesis but stored
  -- statically here. Operator/agent edits when forking.
  base_hypotheses_json jsonb NOT NULL DEFAULT '[]'::jsonb,

  -- Best first-touch outreach angle (shape: text). The plan-gen
  -- prompt for forked probes seeds plan.outreachAngle from this.
  best_first_touch_angle text,

  -- Common objections + how to handle. Free-form jsonb so operator
  -- can edit directly from the playbook detail page.
  common_objections_json jsonb NOT NULL DEFAULT '[]'::jsonb,

  -- Useful data sources for this market type. Free text — operator
  -- adds as they discover new sources.
  useful_data_sources text[] NOT NULL DEFAULT ARRAY[]::text[],

  -- Compliance / regulatory notes that apply across markets in scope.
  -- e.g. "Caribbean food: USDA FDA Foreign Supplier Verification
  -- Program applies; ask about FSVP compliance status during pain
  -- discovery."
  compliance_notes text,

  -- follow-up cadence shape: { days_after_first_touch: 5,
  --                            max_followups: 2, ... }
  follow_up_cadence_json jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- Conversion benchmarks measured from the source probe(s). Each
  -- new probe forked from this playbook compares against these.
  --   { replyRate, routingRate, qualifiedInterestRate, bounceRate }
  conversion_benchmarks_json jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- Provenance — which probes contributed to this playbook version.
  source_probe_ids text[] NOT NULL DEFAULT ARRAY[]::text[],

  -- Versioning. v1, v2, v3 — incremented when refining. Self-FK so
  -- v2 points at v1's id, fork chains traceable back to root.
  version integer NOT NULL DEFAULT 1,
  parent_playbook_id text REFERENCES market_playbooks(id) ON DELETE SET NULL,

  -- 'draft' (operator working on it) | 'active' (in use, available
  -- to fork) | 'deprecated' (replaced by a successor).
  status text NOT NULL DEFAULT 'draft',

  created_by_user_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS market_playbooks_status_idx
  ON market_playbooks(status);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS market_playbooks_parent_idx
  ON market_playbooks(parent_playbook_id);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS market_playbooks_countries_idx
  ON market_playbooks USING gin(applicable_countries);

--> statement-breakpoint

CREATE TABLE IF NOT EXISTS market_probe_learning_reports (
  id text PRIMARY KEY,
  probe_id text NOT NULL REFERENCES market_probes(id) ON DELETE CASCADE,

  -- TL;DR shown on the probe detail page + dashboard cards. One
  -- sentence the agent emits along with the structured report.
  summary text NOT NULL,

  -- Full structured report (shape matches the agent's output schema —
  -- see @procur/ai/market-probes/learning-report-agent.ts):
  --   {
  --     whatWeBelievedAtStart: string,
  --     whatChanged: string,
  --     whatWorked: string[],
  --     whatFailed: string[],
  --     bestSegment: { name, evidence },
  --     worstSegment: { name, evidence },
  --     bestContactTitle: { title, evidence },
  --     strongestSignal: { signal, replyDelta, evidence },
  --     noisySignals: string[],
  --     badTargetRules: string[],   // proposed atlas negative_rule entries
  --     recommendedNextProbe: { country, segments, hypotheses[] },
  --     playbookUpdates: { ... fields the operator should consider
  --                            saving to a playbook ... }
  --   }
  payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- Snapshot of the scorecard at report time so the report is
  -- reproducible — even if the probe gets re-run later, this report's
  -- numbers don't shift.
  scorecard_snapshot_json jsonb NOT NULL DEFAULT '{}'::jsonb,

  generated_by_model text,
  generated_at timestamptz NOT NULL DEFAULT now()
);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS market_probe_learning_reports_probe_idx
  ON market_probe_learning_reports(probe_id);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS market_probe_learning_reports_generated_at_idx
  ON market_probe_learning_reports(generated_at DESC);
