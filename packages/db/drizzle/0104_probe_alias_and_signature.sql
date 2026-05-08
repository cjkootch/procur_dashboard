-- Per-probe outreach identity.
--
-- Three new nullable columns on market_probes carry the probe's
-- outreach persona — the display name and signature blocks autopilot
-- dispatch (and the chat-tool path when called with a probe id) use
-- to override company-level defaults.
--
-- Discipline: the underlying From address stays the company-default
-- Resend address (avoids per-probe DNS / identity verification); only
-- the display name + signature shift. NULL falls back to
-- companies.email_sender_display_name + email_signature_text/html
-- (existing behavior — zero impact on probes that don't set these).
--
-- Idempotent: ADD COLUMN IF NOT EXISTS so re-runs after partial
-- failure are safe per the migrate.ts runner expectations on Neon
-- HTTP. No backfill — existing in-flight probes keep using company
-- defaults until an operator explicitly sets a probe-level value.

ALTER TABLE market_probes
  ADD COLUMN IF NOT EXISTS alias text;

--> statement-breakpoint

ALTER TABLE market_probes
  ADD COLUMN IF NOT EXISTS email_signature_text text;

--> statement-breakpoint

ALTER TABLE market_probes
  ADD COLUMN IF NOT EXISTS email_signature_html text;
