-- Rename match_queue status value `pushed-to-vex` → `qualified` to
-- align with the post-merge UI label (vex's deployment is offline;
-- the action is now qualify-as-lead in-process).
--
-- Idempotent: re-runs are no-ops since rows already updated to
-- 'qualified' won't match the WHERE clause.
--
-- Column names (`pushed_to_vex_at`, `vex_deal_id`) and the
-- match_outcome_events table are intentionally left alone in this
-- pass — renaming columns and dropping that table cascades into
-- queries.ts, the match-outcome webhook, and the
-- match_signal_performance view. Schedule that as a separate
-- migration once readers are updated.

UPDATE match_queue
   SET status = 'qualified'
 WHERE status = 'pushed-to-vex';
