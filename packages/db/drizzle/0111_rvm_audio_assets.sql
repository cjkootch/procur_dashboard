-- Pre-recorded audio assets for ringless voicemail (RVM) dispatch.
--
-- The autopilot's RVM executor plays audio from this table via
-- Twilio TwiML <Play> on machine_end_beep detection. Audio bytes
-- live in Vercel Blob; this row carries metadata + link.
--
-- Scope: per (probe, variant, language). variant_id null = probe-
-- default. Active gating preserves audit history when operators
-- iterate; unique partial index ensures one active per scope.

CREATE TABLE IF NOT EXISTS rvm_audio_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  probe_id text NOT NULL,
  variant_id text,

  language text NOT NULL,

  source_text text NOT NULL,

  audio_url text NOT NULL,
  audio_format text NOT NULL DEFAULT 'audio/mpeg',
  duration_ms integer,

  voice_profile_id text,

  -- 'voicebox' | 'manual_upload' | 'elevenlabs' | 'other'
  generated_via text NOT NULL,

  generated_at timestamptz NOT NULL DEFAULT now(),
  generated_by_user_id text,

  is_active boolean NOT NULL DEFAULT true,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS rvm_audio_assets_probe_idx
  ON rvm_audio_assets (probe_id);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS rvm_audio_assets_variant_idx
  ON rvm_audio_assets (variant_id)
  WHERE variant_id IS NOT NULL;

--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS rvm_audio_assets_active_uniq
  ON rvm_audio_assets (probe_id, variant_id, language)
  WHERE is_active;
