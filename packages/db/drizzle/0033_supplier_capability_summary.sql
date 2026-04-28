-- Supplier capability summary — materialized view that rolls up
-- award counts and totals per supplier so reverse-search and the
-- supplier-recommendation tools answer in milliseconds instead of
-- aggregating 5,000+ award rows on every query.
--
-- Per the brief (section 4.7), refresh CONCURRENTLY nightly via a
-- Trigger.dev job — that job is NOT created in this PR (out of
-- scope; spec it in a follow-up). REFRESH ... CONCURRENTLY requires
-- the unique index on supplier_id below.
--
-- The category-count columns hard-code the VTC commodity taxonomy.
-- New categories should add a column here AND update the
-- supplier-recommendation query module — neither side picks them up
-- automatically.

CREATE MATERIALIZED VIEW supplier_capability_summary AS
SELECT
  s.id AS supplier_id,
  s.organisation_name,
  s.country,

  -- Counts per category (drives reverse search)
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

  -- Volume signals
  SUM(a.contract_value_usd)                                          AS total_value_usd,
  COUNT(*)                                                            AS total_awards,
  MAX(a.award_date)                                                   AS most_recent_award_date,
  MIN(a.award_date)                                                   AS first_award_date,

  -- Geography arrays for "where do they deliver"
  ARRAY_AGG(DISTINCT a.beneficiary_country) FILTER (WHERE a.beneficiary_country IS NOT NULL)
                                                                      AS beneficiary_countries,
  ARRAY_AGG(DISTINCT a.buyer_country)                                AS buyer_countries
FROM external_suppliers s
JOIN award_awardees aa ON aa.supplier_id = s.id
JOIN awards a          ON a.id = aa.award_id
GROUP BY s.id, s.organisation_name, s.country;
--> statement-breakpoint

-- Unique index required for REFRESH MATERIALIZED VIEW CONCURRENTLY.
CREATE UNIQUE INDEX supplier_cap_summary_supplier_idx
  ON supplier_capability_summary (supplier_id);
--> statement-breakpoint

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
