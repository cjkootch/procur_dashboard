-- Per-tenant match queue scoping.
--
-- v1 (migration 0050) shipped with a single global queue keyed only
-- on (source_table, source_id). To onboard a second tenant with its
-- own preferred categories / jurisdictions, every row needs to be
-- owned by exactly one company so the scoring cron can write
-- tenant-scoped duplicates of the same source signal (different
-- baseline/relevance per tenant) and the UI can filter cleanly.
--
-- Existing rows are wiped: the queue is daily and self-heals on the
-- next 15:30 UTC scoring run, so there's no value in backfilling
-- them to NULL company_id and complicating queries with COALESCE.

TRUNCATE TABLE match_queue;
--> statement-breakpoint

ALTER TABLE match_queue
  ADD COLUMN company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE;
--> statement-breakpoint

DROP INDEX IF EXISTS match_queue_open_score_idx;
--> statement-breakpoint

CREATE INDEX match_queue_open_score_idx
  ON match_queue (company_id, status, score DESC, observed_at DESC);
--> statement-breakpoint

DROP INDEX IF EXISTS match_queue_dedup_idx;
--> statement-breakpoint

CREATE UNIQUE INDEX match_queue_dedup_idx
  ON match_queue (company_id, source_table, source_id);
