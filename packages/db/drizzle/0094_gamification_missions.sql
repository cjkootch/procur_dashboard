-- Mission instances — gamification slice 4. Tracks per-deal "live
-- missions" (a checklist of stages the operator works through to
-- close a fuel_deal) plus operator-defined custom missions created
-- via the chat assistant.
--
-- Two flavors live in the same table:
--
--   1. Registered missions (kind='deal_lifecycle' for v1) — stages
--      come from MISSION_REGISTRY in catalog code; the row references
--      a subject (fuel_deals.id) and stages auto-evaluate via SQL
--      predicates that fire from the home page render hook.
--
--   2. Custom missions (kind='custom') — operator defines stages
--      ad-hoc through the chat assistant. Stage list is stored
--      inline as JSONB. Stages complete manually (the operator
--      clicks "Mark done") rather than via predicate.
--
-- Both share the same stage_completions JSONB ({stageKey: ISO ts})
-- so the UI render path doesn't have to branch.

CREATE TABLE IF NOT EXISTS mission_instances (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- 'deal_lifecycle' for registered missions; 'custom' for chat-
  -- created missions. New registered kinds can land later by adding
  -- entries to MISSION_REGISTRY in code — no migration needed.
  kind              text NOT NULL,
  -- Optional pointer to the entity this mission tracks. Null for
  -- custom missions. For deal_lifecycle, subject_type='fuel_deal'
  -- and subject_id=fuel_deals.id (text/ULID).
  subject_type      text,
  subject_id        text,
  title             text NOT NULL,
  description       text,
  -- Inline stage list for custom missions. Null for registered
  -- missions (their stages come from the catalog code registry).
  -- Shape: [{ key, title, description?, xpReward, predicate: 'manual' }]
  custom_stages     jsonb,
  -- 'active' | 'complete' | 'abandoned'
  status            text NOT NULL DEFAULT 'active',
  -- Map of stage_key → ISO completion timestamp. Empty until the
  -- first stage completes.
  stage_completions jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  completed_at      timestamptz,
  abandoned_at      timestamptz,
  -- Optional approval that triggered creation (chat-proposed
  -- custom missions ride through /approvals).
  approval_id       uuid
);
--> statement-breakpoint

-- Idempotent spawn: at most one active mission per
-- (user, kind, subject_id) when subject_id is set. Custom missions
-- (subject_id null) can stack freely.
CREATE UNIQUE INDEX IF NOT EXISTS mission_instances_user_kind_subject_uniq_idx
  ON mission_instances (user_id, kind, subject_id)
  WHERE subject_id IS NOT NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS mission_instances_user_status_idx
  ON mission_instances (user_id, status, created_at DESC);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS mission_instances_subject_idx
  ON mission_instances (subject_type, subject_id);
