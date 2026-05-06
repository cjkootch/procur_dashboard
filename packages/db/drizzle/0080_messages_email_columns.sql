-- Vex-into-procur merge Phase 3 — email-specific columns on messages.
-- Per docs/vex-into-procur-merge-brief.md.
--
-- The Phase 1 messages table is generic (threadId, direction, contentRef,
-- sentiment, outcome, metadata). For inbound email + reply threading we
-- need indexable columns:
--   - subject: thread title; populated on every email row
--   - from_email: lower-cased sender; powers contact match + filters
--   - message_id: RFC-5322 Message-ID; UNIQUE so dedup works without
--     reading raw_events
--   - in_reply_to: parent message's RFC-5322 id; powers thread stitching
--
-- Body text/html stay in metadata JSONB (capped 64KB by the normalizer).
-- All new columns nullable so historical rows continue to validate.

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS subject text;
--> statement-breakpoint

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS from_email text;
--> statement-breakpoint

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS message_id text;
--> statement-breakpoint

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS in_reply_to text;
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS messages_message_id_uniq
  ON messages (message_id)
  WHERE message_id IS NOT NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS messages_in_reply_to_idx
  ON messages (in_reply_to)
  WHERE in_reply_to IS NOT NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS messages_from_email_idx
  ON messages (from_email)
  WHERE from_email IS NOT NULL;
