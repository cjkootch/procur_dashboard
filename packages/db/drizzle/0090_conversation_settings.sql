-- Per-conversation agent settings — Slice 1 of the conversation
-- agent system. Powers the right-rail settings panel on /messages
-- and /inbox.
--
-- One row per (channel, conversation_key). Channel is 'sms' |
-- 'whatsapp' | 'email'; conversation_key is the E.164 phone for
-- SMS / WhatsApp and the thread_id for email. Same shape across
-- channels with channel-specific knobs in `channel_config` JSONB.
--
-- Slice 1 ships the storage + UI. No agent automation yet — AI is
-- off by default; operator turns it on per-conversation. Slices 2
-- and 3 wire the inbound-webhook → agent path that reads these
-- settings.

CREATE TABLE IF NOT EXISTS conversation_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  /* Channel + key uniquely identify a conversation. */
  channel text NOT NULL,
  conversation_key text NOT NULL,

  /* Authority — what the AI is allowed to do. */
  ai_enabled boolean NOT NULL DEFAULT false,
  /* 'chitchat_only' | 'ranges_only' | 'commit_with_approval' */
  authority text NOT NULL DEFAULT 'chitchat_only',
  /* 'full_approval' | 'tiered' | 'business_hours_only' */
  approval_mode text NOT NULL DEFAULT 'full_approval',

  /* Goal + handoff. */
  objective text,
  custom_prompt text,
  handoff_triggers jsonb NOT NULL DEFAULT '{}'::jsonb,
  stop_keywords text[] NOT NULL DEFAULT ARRAY[]::text[],

  /* Persona. */
  tone text NOT NULL DEFAULT 'brokerage_direct',
  language text NOT NULL DEFAULT 'auto',
  identity_disclosure text NOT NULL DEFAULT 'on_request',

  /* Grounding — link the conversation to procur records so the AI
     has the right context. */
  linked_lead_id text,
  linked_deal_id text,
  linked_entity_slug text,

  /* Cadence + scheduling. Channel-specific defaults live in the
     catalog helper, not here — schema just stores whatever the
     operator configured. */
  response_delay_min_sec integer NOT NULL DEFAULT 30,
  response_delay_max_sec integer NOT NULL DEFAULT 90,
  follow_up_ladder_hours integer[] NOT NULL DEFAULT ARRAY[2, 24, 72],
  quiet_hours_start_local integer,
  quiet_hours_end_local integer,
  recipient_timezone text,

  /* Budget — caps to prevent runaway loops. */
  max_turns integer NOT NULL DEFAULT 8,
  max_cost_usd_cents integer NOT NULL DEFAULT 50,
  max_duration_hours integer NOT NULL DEFAULT 24,

  /* State. Mutable as the conversation runs. */
  paused_at timestamptz,
  paused_reason text,
  total_turns integer NOT NULL DEFAULT 0,
  total_cost_usd_micros bigint NOT NULL DEFAULT 0,

  /* Channel-specific knobs that don't apply to every channel. Email
     uses this for: reply_to_all, subject_lock, signature_id,
     attachment_policy, response_length_target, etc. */
  channel_config jsonb NOT NULL DEFAULT '{}'::jsonb,

  /* Audit. */
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by_user_id text
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS conversation_settings_channel_key_uniq_idx
  ON conversation_settings (channel, conversation_key);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS conversation_settings_ai_enabled_idx
  ON conversation_settings (ai_enabled)
  WHERE ai_enabled = true;
