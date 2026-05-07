-- Gamification foundation (Slice 1 per docs / plan).
--
-- Two tables:
--   xp_ledger          — append-only log of earned XP. Source-of-truth
--                        for level + streak + total XP. References events
--                        when applicable but allows free-standing rows
--                        (quest completes, achievement awards, manual).
--   achievements_earned — per-user record of unlocked achievements. One
--                        row per (user, achievement key); populated when
--                        an achievement predicate first transitions to
--                        true.
--
-- Both are idempotent on first run: backfill scans historical events
-- and emits ledger rows keyed on (source_table, source_id, verb), so
-- re-running the backfill never double-credits.

CREATE TABLE IF NOT EXISTS xp_ledger (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- The events.id that generated this credit, when applicable. Null for
  -- quest completes, achievement awards, manual adjustments.
  event_id      uuid,
  -- Polymorphic source pointer for ledger rows that don't have an
  -- events.id (feedback_events / extracted_entities resolutions /
  -- deal_retrospectives completions / supplier_approvals transitions).
  -- Used by the backfill scanner's idempotency check.
  source_table  text,
  source_id     text,
  -- Verb taxonomy mirrors the events table where possible (outreach.*),
  -- with extra namespaces for feedback / kyc / quest / achievement /
  -- manual.
  verb          text NOT NULL,
  points        integer NOT NULL,
  -- Free-text "why" — surfaces in the toast as the user-visible label
  -- (e.g. "Outreach replied", "Quest: Three at the Bell").
  reason        text NOT NULL,
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  created_at    timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS xp_ledger_user_occurred_idx
  ON xp_ledger (user_id, occurred_at DESC);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS xp_ledger_event_id_idx
  ON xp_ledger (event_id) WHERE event_id IS NOT NULL;
--> statement-breakpoint

-- Idempotency key for the backfill scanner. Partial — most ledger rows
-- have NULL source pointers (quest completes, achievement awards). The
-- partial index keeps it cheap on the common path.
CREATE UNIQUE INDEX IF NOT EXISTS xp_ledger_source_verb_uniq_idx
  ON xp_ledger (source_table, source_id, verb)
  WHERE source_table IS NOT NULL AND source_id IS NOT NULL;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS achievements_earned (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  achievement_key text NOT NULL,
  earned_at       timestamptz NOT NULL DEFAULT now(),
  -- Optional event id pointer to the action that triggered the unlock
  -- (the outreach.replied row that crossed the threshold, etc.).
  event_id        uuid,
  created_at      timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS achievements_earned_user_key_uniq_idx
  ON achievements_earned (user_id, achievement_key);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS achievements_earned_user_earned_idx
  ON achievements_earned (user_id, earned_at DESC);
