-- Unified feedback events per docs/feedback-ui-brief.md §3.1.
-- Single table for all five patterns (match-quality, entity attribute,
-- friction, disposition, retrospective). Pattern-specific data lives
-- in the JSONB payload column.
--
-- Coexists with the existing match_outcome_events table (PR #309 in
-- vex). Per brief §3.2, the match-queue UI writes to BOTH on Pattern
-- 1 actions — feedback_events for unified analytics, match_outcome_events
-- stays untouched for backward compatibility with existing consumers.

CREATE TABLE IF NOT EXISTS feedback_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  /** Clerk user id. Optional — anon procur usage shouldn't drop
      events; null is acceptable for system-attributed feedback. */
  user_id text,

  /** Which of the five patterns this event belongs to:
        'match_quality' | 'entity_attribute' | 'friction'
        | 'disposition' | 'retrospective'
      Free text — new kinds slot in without migration. */
  feedback_kind text NOT NULL,

  /** What the event is about:
        'match' | 'entity' | 'signal' | 'deal' | 'global' */
  target_type text,
  /** ID of the target object — match.id, entity slug, deal id, etc.
      Stored as text to support all the canonical-key shapes used
      across procur. */
  target_id text,
  /** For compound references — e.g. (entity_slug, signal_source) for
      mute rules; (entity_slug, attribute_name) for attribute corrections. */
  target_secondary_id text,

  /** Extracted from payload for indexability so "all negative
      feedback on this entity" doesn't need JSONB unpacking:
        'positive' | 'negative' | 'neutral' | 'mute' | 'pin' */
  sentiment text,

  /** Pattern-specific data. Schema varies per feedback_kind. */
  payload jsonb NOT NULL DEFAULT '{}',

  /** Captured situational context — page URL, recent search,
      navigation path, current entity. Auto-captured client-side
      so the user never has to "explain where I was." */
  context jsonb,

  created_at timestamp NOT NULL DEFAULT now(),

  /** Soft-delete for "actually I didn't mean that" patterns.
      Preserves the original signal for audit while removing it
      from active feedback aggregation. */
  revoked_at timestamp
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS feedback_events_user_idx
  ON feedback_events (user_id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS feedback_events_kind_idx
  ON feedback_events (feedback_kind);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS feedback_events_target_idx
  ON feedback_events (target_type, target_id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS feedback_events_created_idx
  ON feedback_events (created_at DESC);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS feedback_events_payload_idx
  ON feedback_events USING gin (payload);
--> statement-breakpoint

-- Mute rules (Pattern 1) — structural, not just per-instance.
-- "For entity X, suppress signals of type Y from source Z." Future
-- match-queue rows matching are filtered out server-side.
CREATE TABLE IF NOT EXISTS signal_mute_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL,
  /** Same canonical-key shape elsewhere — known_entities.slug or
      external_suppliers.id (UUID). */
  entity_slug text NOT NULL,
  /** Signal type from match_queue.signal_type
      (distress_event, velocity_drop, new_award, etc.). */
  signal_type text NOT NULL,
  /** Optional source pin — null means "any source for this type". */
  signal_source text,
  muted_at timestamp NOT NULL DEFAULT now(),
  /** NULL = indefinite. Brief §11 calls expiration policy
      deferred-to-implementation; we ship indefinite first. */
  muted_until timestamp,
  created_at timestamp NOT NULL DEFAULT now()
);
--> statement-breakpoint

-- Match-queue suppression query joins this table — unique-per-rule
-- so re-muting is a noop, not duplicate rows.
CREATE UNIQUE INDEX IF NOT EXISTS signal_mute_rules_uniq_idx
  ON signal_mute_rules (user_id, entity_slug, signal_type, COALESCE(signal_source, ''));
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS signal_mute_rules_user_idx
  ON signal_mute_rules (user_id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS signal_mute_rules_entity_idx
  ON signal_mute_rules (entity_slug);
