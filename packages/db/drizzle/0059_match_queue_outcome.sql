-- Match-queue outcome feedback loop.
--
-- Brief: docs/data-graph-connections-brief.md §4 (work item 3).
--
-- Adds five columns to match_queue capturing the lifecycle from
-- "pushed to vex" through to terminal outcome ('closed_won',
-- 'closed_lost', 'no_engagement', 'still_active'). Plus a
-- match_signal_performance view that aggregates conversion rates
-- per signal_kind so the scoring algorithm can be calibrated
-- against actual deal results instead of static heuristics.
--
-- Vex calls POST /api/intelligence/match-outcome to set:
--   - vexDealId / pushedToVexAt — when a fuel_deal is created from
--     a procur lead.
--   - dealOutcome / outcomeRecordedAt / realizedMarginUsd — when
--     the linked deal terminates.
-- See apps/app/app/api/intelligence/match-outcome/route.ts.

ALTER TABLE match_queue
  ADD COLUMN IF NOT EXISTS pushed_to_vex_at timestamp with time zone;
--> statement-breakpoint

ALTER TABLE match_queue
  ADD COLUMN IF NOT EXISTS vex_deal_id text;
--> statement-breakpoint

-- 'closed_won' | 'closed_lost' | 'no_engagement' | 'still_active'.
-- Validated at the route layer; left as text here so future enum
-- additions don't need a migration.
ALTER TABLE match_queue
  ADD COLUMN IF NOT EXISTS deal_outcome text;
--> statement-breakpoint

ALTER TABLE match_queue
  ADD COLUMN IF NOT EXISTS outcome_recorded_at timestamp with time zone;
--> statement-breakpoint

-- USD margin captured from vex's deal close metrics. Null when
-- outcome is anything other than 'closed_won'.
ALTER TABLE match_queue
  ADD COLUMN IF NOT EXISTS realized_margin_usd numeric(14, 2);
--> statement-breakpoint

-- "Show me unresolved pushed matches" / "show me last 90 days of
-- closed_won". Composite index on the outcome lifecycle columns.
CREATE INDEX IF NOT EXISTS match_queue_outcome_idx
  ON match_queue (deal_outcome, outcome_recorded_at DESC NULLS LAST)
  WHERE deal_outcome IS NOT NULL;
--> statement-breakpoint

-- Lookup-by-vex-deal-id for the outcome webhook's "find the
-- match this deal came from" path.
CREATE INDEX IF NOT EXISTS match_queue_vex_deal_id_idx
  ON match_queue (vex_deal_id)
  WHERE vex_deal_id IS NOT NULL;
--> statement-breakpoint

-- Per-signal conversion rates over the trailing 90 days. Powers
-- the system-prompt match-presentation discipline + the future
-- "calibrate the scoring algorithm" workstream described in
-- strategic-vision.md §9.
--
-- Window is 90 days as a default; longer-cycle deals (specialty
-- crude, ~120-180d) appear with longer lag. Use a 180-day variant
-- of this view for specialty crude analysis when needed.
CREATE OR REPLACE VIEW match_signal_performance AS
WITH outcomes AS (
  SELECT
    signal_kind,
    COUNT(*) FILTER (WHERE matched_at >= NOW() - INTERVAL '90 days')
      AS total_90d,
    COUNT(*) FILTER (
      WHERE matched_at >= NOW() - INTERVAL '90 days'
        AND status IN ('pushed-to-vex', 'actioned')
    ) AS actioned_90d,
    COUNT(*) FILTER (
      WHERE matched_at >= NOW() - INTERVAL '90 days'
        AND deal_outcome = 'closed_won'
    ) AS closed_won_90d,
    COUNT(*) FILTER (
      WHERE matched_at >= NOW() - INTERVAL '90 days'
        AND deal_outcome = 'closed_lost'
    ) AS closed_lost_90d,
    AVG(realized_margin_usd) FILTER (WHERE deal_outcome = 'closed_won')
      AS avg_margin_won_usd,
    SUM(realized_margin_usd) FILTER (WHERE deal_outcome = 'closed_won')
      AS total_margin_won_usd
  FROM match_queue
  GROUP BY signal_kind
)
SELECT
  signal_kind,
  total_90d,
  actioned_90d,
  closed_won_90d,
  closed_lost_90d,
  -- % of matches the operator chose to push.
  ROUND(
    (actioned_90d::numeric / NULLIF(total_90d, 0)) * 100,
    1
  ) AS action_rate_pct,
  -- % of matches that converted to a closed_won deal.
  ROUND(
    (closed_won_90d::numeric / NULLIF(total_90d, 0)) * 100,
    2
  ) AS close_rate_pct,
  -- Of pushed matches, how many converted? (Excludes the operator's
  -- "this is noise" filter from the denominator — measures vex-side
  -- conversion not procur-side selection.)
  ROUND(
    (closed_won_90d::numeric / NULLIF(actioned_90d, 0)) * 100,
    2
  ) AS conversion_rate_pct,
  ROUND(avg_margin_won_usd, 2) AS avg_margin_won_usd,
  ROUND(total_margin_won_usd, 2) AS total_margin_won_usd
FROM outcomes
ORDER BY close_rate_pct DESC NULLS LAST,
         total_margin_won_usd DESC NULLS LAST;
