-- Per-company email defaults applied to every approved email.send.
-- Read by packages/ai/src/executors/email-send.ts at dispatch time;
-- managed via /settings/email in apps/app.
--
-- Idempotent — uses ADD COLUMN IF NOT EXISTS so a partial-failure
-- replay is safe (Neon HTTP is auto-commit per call).

ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS email_sender_display_name text;
--> statement-breakpoint

ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS email_always_cc jsonb NOT NULL DEFAULT '[]'::jsonb;
--> statement-breakpoint

ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS email_signature_html text;
--> statement-breakpoint

ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS email_signature_text text;
