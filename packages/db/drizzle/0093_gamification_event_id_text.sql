-- Widen `event_id` from uuid → text on both gamification tables.
-- The events table uses ULIDs (text) as ids, but the original
-- migration 0092 typed `event_id` as uuid expecting UUIDs. Backfill
-- fails at the first insert with NeonDbError 22P02 ("invalid input
-- syntax for type uuid").
--
-- xp_ledger.event_id and achievements_earned.event_id are both
-- nullable, no FK constraint, no data populated yet (backfill
-- never completed), so the ALTER is straightforward.

ALTER TABLE xp_ledger ALTER COLUMN event_id TYPE text USING event_id::text;
--> statement-breakpoint

ALTER TABLE achievements_earned ALTER COLUMN event_id TYPE text USING event_id::text;
