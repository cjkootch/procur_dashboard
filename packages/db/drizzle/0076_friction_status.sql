-- Pattern 3 (friction logging) lifecycle table per
-- docs/feedback-ui-brief.md §6.4. Friction events themselves live in
-- feedback_events (kind='friction'); this table tracks the
-- "logged → reviewing → in_progress → shipped/wontfix" status the
-- analyst (or a future Trigger.dev cron) updates.
--
-- 1:1 with feedback_events.id when a feedback row is created with
-- kind='friction'. Separated so the lifecycle stays mutable without
-- mutating the feedback log.

CREATE TABLE IF NOT EXISTS friction_status (
  feedback_event_id uuid PRIMARY KEY REFERENCES feedback_events(id) ON DELETE CASCADE,
  /** 'logged' | 'reviewing' | 'in_progress' | 'shipped' | 'wontfix' */
  status text NOT NULL DEFAULT 'logged',
  resolution_note text,
  resolved_at timestamp,
  /** PR / issue URL once the friction has a tracking artifact. */
  related_pr_url text,
  updated_at timestamp NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS friction_status_status_idx
  ON friction_status (status);
