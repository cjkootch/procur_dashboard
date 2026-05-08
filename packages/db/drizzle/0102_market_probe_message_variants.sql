-- Phase 2I.4: message variant testing for Market Probes.
--
-- Operator authors 2-3 message variants per probe (different subject
-- lines, different first-touch angles, different tones). Autopilot
-- picks one per target via weighted sampling among 'active' variants.
-- Per-variant outcomes (sent/replied/positive/bounced) aggregate by
-- joining market_probe_targets.variant_id; the probe scorecard
-- surfaces the winning variant.
--
-- The simplest schema that captures the test is one new table for
-- variants + one nullable foreign-key column on market_probe_targets.
-- Per-variant outcome counts get computed on demand (cheap; one
-- GROUP BY) rather than denormalized — keeps writes simple and there's
-- no chance of drift between authoritative and cached counts.

CREATE TABLE IF NOT EXISTS market_probe_message_variants (
  id text PRIMARY KEY,
  probe_id text NOT NULL REFERENCES market_probes(id) ON DELETE CASCADE,

  variant_name text NOT NULL,
  -- 'active' (eligible for autopilot selection) | 'paused' (operator
  -- temporarily disabled) | 'winner' (operator promoted; autopilot
  -- uses ONLY this variant) | 'archived' (kept for history).
  status text NOT NULL DEFAULT 'active',

  -- Subject + body templates. Used by the autopilot's draft step as
  -- intent text for draftOutreachFromContext. Operator-authored;
  -- can be regenerated from a Sonnet pass.
  subject_template text,
  body_template text,
  angle text,

  -- Sampling weight when picking among active variants. Default 1
  -- = uniform sampling across all active variants. Operator bumps
  -- a winning variant to push more sends through it without yet
  -- promoting to 'winner' status.
  weight numeric NOT NULL DEFAULT 1,

  notes text,
  -- Self-FK for fork chains — v2 of a variant points at v1.
  parent_variant_id text REFERENCES market_probe_message_variants(id) ON DELETE SET NULL,

  created_by_user_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS market_probe_message_variants_probe_idx
  ON market_probe_message_variants(probe_id);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS market_probe_message_variants_status_idx
  ON market_probe_message_variants(probe_id, status);

--> statement-breakpoint

-- Stamp the chosen variant on each target. Nullable for targets
-- created before variants existed (operator created the probe pre-
-- 2I.4 and never authored variants — autopilot falls back to the
-- plan-derived intent string from Phase 2H).
ALTER TABLE market_probe_targets
  ADD COLUMN IF NOT EXISTS variant_id text
    REFERENCES market_probe_message_variants(id) ON DELETE SET NULL;

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS market_probe_targets_variant_idx
  ON market_probe_targets(variant_id)
  WHERE variant_id IS NOT NULL;
