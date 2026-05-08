-- Per-probe outreach language for first-touch drafts.
--
-- ISO 639-1 lowercase code (en, ja, fr, de, ko, zh, es, etc.).
-- When set, both drafters (email + lead-form) write in this
-- language regardless of the operator's English intent. Also
-- seeds conversation_settings.language at autopilot first-contact
-- so the reply path stays in the same language across the thread.
--
-- Without this column, the email drafter has no language hint at
-- all (the lead-form drafter at least had the form's <html lang>
-- attribute) — Japan / France / Korea probes would write English
-- first-touch even when the operator wanted local language.
--
-- NULL falls back to:
--   - Email drafter: English (existing behavior)
--   - Lead-form drafter: form's HTML lang attribute or English
--   - conversation_settings.language: 'auto' (recipient's reply
--     language; existing behavior)
--
-- Idempotent + nullable. Existing probes keep using English
-- first-touch + 'auto' reply language until an operator sets a
-- value.

ALTER TABLE market_probes
  ADD COLUMN IF NOT EXISTS outreach_language text;
