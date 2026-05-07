-- Backfill: normalize messages.message_id and messages.in_reply_to to
-- the bracket-less + lowercase form so the inbound-webhook lookup
-- (which now normalizes its In-Reply-To before matching) finds
-- already-sent outbounds.
--
-- Different mail relays format RFC 5322 Message-ID strings
-- inconsistently: some preserve <id@host>, some strip the angle
-- brackets, some lowercase the local-part. The post-normalize code
-- writes new rows in the canonical lowercase-no-brackets form; this
-- migration brings legacy rows into that same shape so threading
-- works end-to-end without keeping a "try both forms" fallback in
-- the lookup path.
--
-- Idempotent — the WHERE guard skips rows already in the canonical
-- form, so re-running this is a no-op.

UPDATE messages
   SET message_id = lower(btrim(btrim(message_id), '<>'))
 WHERE message_id IS NOT NULL
   AND message_id <> lower(btrim(btrim(message_id), '<>'));
--> statement-breakpoint
UPDATE messages
   SET in_reply_to = lower(btrim(btrim(in_reply_to), '<>'))
 WHERE in_reply_to IS NOT NULL
   AND in_reply_to <> lower(btrim(btrim(in_reply_to), '<>'));
