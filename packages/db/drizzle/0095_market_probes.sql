-- Market Probes — bounded autonomous market-prospecting experiments.
--
-- A "probe" is research framed as a controlled experiment: pick a small,
-- low-stakes market, hand the agent a scope, let it identify candidates
-- and route low-risk first-touch outreach within strict caps. The point
-- is to discover whether a market has signal, not to close deals.
--
-- Phase 1 ships the foundation: schema, plan-generation agent, target
-- discovery, manual draft+approve loop. Tier 0 (research-only, every
-- send is operator-approved) is the only mode. Phase 2 layers on Tier 1
-- autopilot + reply triage + digest cron.
--
-- Discipline:
--   - Probes are SEPARATE from `campaigns` (which is the outbound-sequence
--     primitive that's read-only today). Probes have a HYPOTHESIS and a
--     PLAN; campaigns have STEPS. Different mental model.
--   - Per-probe send caps + market fence + blocklists prevent the agent
--     from drifting outside the sandbox.
--   - The plan_json carries a `tasks[]` array — operator-visible
--     checklist that the agent crosses off as it makes progress.

CREATE TABLE IF NOT EXISTS market_probes (
  id text PRIMARY KEY,

  market_name text NOT NULL,
  -- ISO-2 country code; nullable for cross-border probes.
  country text,
  product_thesis text NOT NULL,
  risk_level text NOT NULL DEFAULT 'low',
  -- planning | active | paused | completed | abandoned
  status text NOT NULL DEFAULT 'planning',
  -- 0 = research-only (every send operator-approved)
  -- 1 = first-touch autopilot (within caps)
  -- 2 = follow-up autopilot (low-risk replies only)
  -- 3 = human-gated commercial drafting
  -- New probes default to 0; graduation is an explicit operator action.
  tier integer NOT NULL DEFAULT 0,

  objective text,
  -- { replyCount: 5, qualifiedContacts: 3, leads: 1, bounceRateMaxPct: 8 }
  success_criteria_json jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- Channel + segment fences. Email-only by default; calls/sms/whatsapp
  -- require explicit opt-in per probe.
  allowed_channels text[] NOT NULL DEFAULT ARRAY['email']::text[],
  allowed_segments text[] NOT NULL DEFAULT ARRAY[]::text[],

  -- Block-list of strings the draft must not contain ("price", "$", "USG"…).
  blocked_terms text[] NOT NULL DEFAULT ARRAY[]::text[],
  -- Block-list of entity slugs the probe must not touch (existing strategic
  -- relationships, sensitive counterparties).
  blocked_entity_slugs text[] NOT NULL DEFAULT ARRAY[]::text[],

  -- Volume caps. Conservative defaults; operator can raise per probe.
  daily_send_limit integer NOT NULL DEFAULT 10,
  total_send_limit integer NOT NULL DEFAULT 50,
  max_followups_per_contact integer NOT NULL DEFAULT 1,

  -- The plan: hypothesis + segments + outreach angle + success_criteria
  -- + tasks[]. The tasks array is what the dashboard renders as a
  -- crossing-off checklist. Shape:
  --   {
  --     hypothesis: string,
  --     segments: string[],
  --     outreachAngle: string,
  --     tasks: [
  --       { id, label, status: 'pending'|'in_progress'|'done'|'skipped',
  --         completedAt?: ISO, result?: string }
  --     ]
  --   }
  plan_json jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- Procur user id; no FK because users.id is uuid and createdBy is text
  -- across the rest of the codebase.
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS market_probes_status_idx ON market_probes(status);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS market_probes_country_idx ON market_probes(country);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS market_probes_created_at_idx ON market_probes(created_at DESC);

--> statement-breakpoint

CREATE TABLE IF NOT EXISTS market_probe_targets (
  id text PRIMARY KEY,
  probe_id text NOT NULL REFERENCES market_probes(id) ON DELETE CASCADE,

  -- entity_slug stays text — accepts known_entities.slug AND
  -- external_suppliers.id, mirroring the supplier_approvals pattern.
  entity_slug text NOT NULL,
  contact_id text,
  segment text,

  -- A | B | C | D — Tier 1 autopilot only sends to A/B per ChatGPT's
  -- spec. Phase 1 stores; Phase 2 enforces.
  fit_tier text NOT NULL DEFAULT 'C',
  confidence numeric NOT NULL DEFAULT 0,
  evidence_json jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- pending | drafted | queued | sent | bounced | skipped
  send_status text NOT NULL DEFAULT 'pending',
  last_touch_at timestamptz,

  -- positive | routing | objection | unsubscribe | none
  reply_status text,
  -- qualified | disqualified | parked | none — operator's final
  -- judgment after replies land. Phase 1 is operator-set; Phase 4
  -- adds agent-proposed dispositions.
  disposition text,
  human_feedback text,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS market_probe_targets_probe_idx ON market_probe_targets(probe_id);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS market_probe_targets_entity_idx ON market_probe_targets(entity_slug);

--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS market_probe_targets_probe_entity_uniq
  ON market_probe_targets(probe_id, entity_slug);
