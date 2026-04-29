-- Layer 3 — distress + motivation signals (foundation).
--
-- Recreates supplier_capability_summary with rolling-window velocity
-- columns so we can answer "who's losing momentum" / "who has stopped
-- winning" without re-aggregating awards on every query. The signal:
-- a supplier whose award count dropped 50%+ between the prior 90-day
-- window and the most-recent 90-day window is more receptive to a
-- back-to-back trade than one whose pipeline is full.
--
-- Distinct from the existing per-category counts (which are
-- capability cumulative). Velocity is *change* in capability —
-- different question, complementary answer.
--
-- DROP CASCADE because the existing MV may have downstream
-- dependencies; nothing currently references it via a view but
-- CASCADE makes the migration safe regardless. REFRESH ...
-- CONCURRENTLY still works post-recreate because the unique index
-- is preserved.

DROP MATERIALIZED VIEW IF EXISTS supplier_capability_summary CASCADE;
--> statement-breakpoint

CREATE MATERIALIZED VIEW supplier_capability_summary AS
SELECT
  s.id AS supplier_id,
  s.organisation_name,
  s.country,

  -- Counts per category (preserved from 0033 — drives reverse search).
  COUNT(*) FILTER (WHERE 'petroleum-fuels' = ANY(a.category_tags))   AS petroleum_awards,
  COUNT(*) FILTER (WHERE 'crude-oil' = ANY(a.category_tags))         AS crude_awards,
  COUNT(*) FILTER (WHERE 'diesel' = ANY(a.category_tags))            AS diesel_awards,
  COUNT(*) FILTER (WHERE 'gasoline' = ANY(a.category_tags))          AS gasoline_awards,
  COUNT(*) FILTER (WHERE 'jet-fuel' = ANY(a.category_tags)
                     OR 'aviation-fuels' = ANY(a.category_tags))     AS jet_awards,
  COUNT(*) FILTER (WHERE 'lpg' = ANY(a.category_tags))               AS lpg_awards,
  COUNT(*) FILTER (WHERE 'marine-bunker' = ANY(a.category_tags))     AS marine_bunker_awards,
  COUNT(*) FILTER (WHERE 'food-commodities' = ANY(a.category_tags))  AS food_awards,
  COUNT(*) FILTER (WHERE 'vehicles' = ANY(a.category_tags))          AS vehicle_awards,

  -- Cumulative volume signals (preserved).
  SUM(a.contract_value_usd)                                          AS total_value_usd,
  COUNT(*)                                                            AS total_awards,
  MAX(a.award_date)                                                   AS most_recent_award_date,
  MIN(a.award_date)                                                   AS first_award_date,

  -- Geography arrays (preserved).
  ARRAY_AGG(DISTINCT a.beneficiary_country) FILTER (WHERE a.beneficiary_country IS NOT NULL)
                                                                      AS beneficiary_countries,
  ARRAY_AGG(DISTINCT a.buyer_country)                                AS buyer_countries,

  -- NEW — rolling-window velocity. Last 90 days vs the 90 days before.
  COUNT(*) FILTER (
    WHERE a.award_date >= CURRENT_DATE - INTERVAL '90 days'
  ) AS awards_last_90d,
  COUNT(*) FILTER (
    WHERE a.award_date >= CURRENT_DATE - INTERVAL '180 days'
      AND a.award_date <  CURRENT_DATE - INTERVAL '90 days'
  ) AS awards_prev_90d,

  SUM(a.contract_value_usd) FILTER (
    WHERE a.award_date >= CURRENT_DATE - INTERVAL '90 days'
  ) AS value_usd_last_90d,
  SUM(a.contract_value_usd) FILTER (
    WHERE a.award_date >= CURRENT_DATE - INTERVAL '180 days'
      AND a.award_date <  CURRENT_DATE - INTERVAL '90 days'
  ) AS value_usd_prev_90d,

  -- Geographic dispersion proxy: distinct buyer countries in last 12mo.
  -- ARRAY_LENGTH(...,1) returns NULL on empty array — coalesce to 0 so
  -- downstream queries don't have to handle the NULL case.
  COALESCE(
    ARRAY_LENGTH(
      ARRAY_AGG(DISTINCT a.buyer_country) FILTER (
        WHERE a.award_date >= CURRENT_DATE - INTERVAL '365 days'
      ),
      1
    ),
    0
  ) AS distinct_countries_last_12mo

FROM external_suppliers s
JOIN award_awardees aa ON aa.supplier_id = s.id
JOIN awards a          ON a.id = aa.award_id
GROUP BY s.id, s.organisation_name, s.country;
--> statement-breakpoint

-- Unique index required for REFRESH MATERIALIZED VIEW CONCURRENTLY.
CREATE UNIQUE INDEX supplier_cap_summary_supplier_idx
  ON supplier_capability_summary (supplier_id);
--> statement-breakpoint

-- Category indexes preserved from 0033.
CREATE INDEX supplier_cap_summary_crude_idx
  ON supplier_capability_summary (crude_awards DESC, total_value_usd DESC)
  WHERE crude_awards > 0;
--> statement-breakpoint

CREATE INDEX supplier_cap_summary_diesel_idx
  ON supplier_capability_summary (diesel_awards DESC, total_value_usd DESC)
  WHERE diesel_awards > 0;
--> statement-breakpoint

CREATE INDEX supplier_cap_summary_jet_idx
  ON supplier_capability_summary (jet_awards DESC, total_value_usd DESC)
  WHERE jet_awards > 0;
--> statement-breakpoint

CREATE INDEX supplier_cap_summary_recent_idx
  ON supplier_capability_summary (most_recent_award_date DESC);
--> statement-breakpoint

CREATE INDEX supplier_cap_summary_country_idx
  ON supplier_capability_summary (country);
--> statement-breakpoint

-- NEW — partial index on (last_90d, prev_90d) for the distress query.
-- WHERE awards_prev_90d > 0 keeps the index small (most suppliers have
-- 0 prev-period awards and aren't candidates for distress ranking).
CREATE INDEX supplier_cap_summary_velocity_idx
  ON supplier_capability_summary (awards_last_90d, awards_prev_90d)
  WHERE awards_prev_90d > 0;
