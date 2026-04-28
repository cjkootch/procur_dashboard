-- Materialized view: per-award delta vs the prevailing spot benchmark
-- on the award date. The analytical engine for delta-over-benchmark
-- queries (analyzeSupplierPricing / analyzeBuyerPricing /
-- evaluateOfferAgainstHistory).
--
-- Resolution pipeline:
--   1. Resolve effective currency: explicit → country default → 'USD'
--   2. Convert to USD using fx_rates (or use explicit contract_value_usd)
--   3. Divide by quantity_bbl to get unit_price_usd_per_bbl
--   4. Resolve benchmark via 3-tier fallback:
--        (category × country × grade) →
--        (category × country) →
--        (category × 'GLOBAL')
--   5. Pull benchmark spot price on award_date from commodity_prices
--      (or the most-recent prior non-null price within 7 days for
--      weekend/holiday gaps), normalize $/gal → $/bbl by ×42 if needed
--   6. Apply benchmark_adjustment_usd_bbl
--   7. Compute delta_usd_per_bbl + delta_pct
--   8. Score overall_confidence = LEAST(currency, value, quantity, benchmark)
--
-- Refresh nightly with: REFRESH MATERIALIZED VIEW CONCURRENTLY award_price_deltas
-- (requires the unique index defined below).

CREATE MATERIALIZED VIEW IF NOT EXISTS award_price_deltas AS
WITH
-- 1. Effective currency.
awards_with_currency AS (
  SELECT
    a.id AS award_id,
    a.buyer_country,
    a.beneficiary_country,
    a.award_date,
    a.commodity_description,
    a.category_tags,
    a.contract_value_native,
    a.contract_value_usd AS contract_value_usd_explicit,
    a.contract_currency,
    a.quantity_bbl,
    a.quantity_extraction_confidence,
    aa.supplier_id,
    COALESCE(
      a.contract_currency,
      cdc.default_currency,
      'USD'
    ) AS effective_currency,
    CASE
      WHEN a.contract_currency IS NOT NULL THEN 1.0
      WHEN cdc.default_currency IS NOT NULL THEN 0.6
      ELSE 0.3
    END AS currency_confidence
  FROM awards a
  LEFT JOIN country_default_currencies cdc ON cdc.country_code = a.buyer_country
  LEFT JOIN award_awardees aa ON aa.award_id = a.id
  WHERE a.award_date IS NOT NULL
    AND a.quantity_bbl IS NOT NULL
    AND a.quantity_bbl > 0
),

-- 2. USD value (use explicit; else FX-convert from native).
awards_in_usd AS (
  SELECT
    awc.*,
    CASE
      WHEN awc.contract_value_usd_explicit IS NOT NULL THEN awc.contract_value_usd_explicit
      WHEN awc.effective_currency = 'USD' THEN awc.contract_value_native
      WHEN fx.rate_to_usd IS NOT NULL THEN awc.contract_value_native * fx.rate_to_usd
      ELSE NULL
    END AS computed_value_usd,
    CASE
      WHEN awc.contract_value_usd_explicit IS NOT NULL THEN 1.0
      WHEN awc.effective_currency = 'USD' THEN 1.0
      WHEN fx.rate_to_usd IS NOT NULL THEN 0.85
      ELSE 0.0
    END AS value_confidence
  FROM awards_with_currency awc
  LEFT JOIN fx_rates fx
    ON fx.currency_code = awc.effective_currency
    AND fx.rate_date = awc.award_date
),

-- 3. Per-bbl unit price.
awards_per_bbl AS (
  SELECT
    aiu.*,
    CASE
      WHEN aiu.computed_value_usd IS NOT NULL AND aiu.quantity_bbl > 0
        THEN aiu.computed_value_usd::numeric / aiu.quantity_bbl::numeric
      ELSE NULL
    END AS unit_price_usd_per_bbl
  FROM awards_in_usd aiu
),

-- 4. Resolve benchmark (3-tier fallback).
awards_with_benchmark AS (
  SELECT
    apb.*,
    COALESCE(
      cbm_country.benchmark_slug,
      cbm_global.benchmark_slug
    ) AS benchmark_slug,
    COALESCE(
      cbm_country.benchmark_adjustment_usd_bbl,
      cbm_global.benchmark_adjustment_usd_bbl,
      0
    )::numeric AS benchmark_adjustment_usd_bbl,
    CASE
      WHEN cbm_country.benchmark_slug IS NOT NULL THEN 0.8
      WHEN cbm_global.benchmark_slug IS NOT NULL THEN 0.5
      ELSE 0.0
    END AS benchmark_confidence
  FROM awards_per_bbl apb
  LEFT JOIN commodity_benchmark_mappings cbm_country
    ON cbm_country.category_tag = ANY(apb.category_tags)
    AND cbm_country.country_code = apb.buyer_country
    AND cbm_country.grade IS NULL
  LEFT JOIN commodity_benchmark_mappings cbm_global
    ON cbm_global.category_tag = ANY(apb.category_tags)
    AND cbm_global.country_code = 'GLOBAL'
    AND cbm_global.grade IS NULL
),

-- 5. Spot price on award_date (or up to 7 days prior — weekends/holidays).
awards_with_spot AS (
  SELECT
    awb.*,
    cp_recent.price::numeric AS benchmark_price_raw,
    cp_recent.unit AS benchmark_unit,
    -- $/gal → $/bbl: ×42; $/bbl: ×1
    CASE cp_recent.unit
      WHEN 'usd-gal' THEN 42.0::numeric
      WHEN 'usd-bbl' THEN 1.0::numeric
      ELSE NULL
    END AS unit_to_bbl_factor
  FROM awards_with_benchmark awb
  LEFT JOIN LATERAL (
    SELECT price, unit FROM commodity_prices cp
    WHERE cp.series_slug = awb.benchmark_slug
      AND cp.contract_type = 'spot'
      AND cp.price_date <= awb.award_date
      AND cp.price_date >= awb.award_date - INTERVAL '7 days'
    ORDER BY cp.price_date DESC
    LIMIT 1
  ) cp_recent ON true
)

-- 6. Final select with delta + overall confidence.
SELECT
  award_id,
  supplier_id,
  buyer_country,
  beneficiary_country,
  award_date,
  category_tags,
  effective_currency,
  computed_value_usd,
  quantity_bbl,
  unit_price_usd_per_bbl,
  benchmark_slug,
  benchmark_price_raw,
  benchmark_unit,
  -- Convert benchmark to $/bbl (×42 for $/gal; ×1 for $/bbl).
  (benchmark_price_raw * unit_to_bbl_factor + benchmark_adjustment_usd_bbl)
    AS benchmark_price_usd_per_bbl,
  benchmark_adjustment_usd_bbl,
  -- Delta
  CASE
    WHEN unit_price_usd_per_bbl IS NOT NULL
      AND benchmark_price_raw IS NOT NULL
      AND unit_to_bbl_factor IS NOT NULL
      THEN unit_price_usd_per_bbl
           - (benchmark_price_raw * unit_to_bbl_factor + benchmark_adjustment_usd_bbl)
    ELSE NULL
  END AS delta_usd_per_bbl,
  CASE
    WHEN unit_price_usd_per_bbl IS NOT NULL
      AND benchmark_price_raw IS NOT NULL
      AND unit_to_bbl_factor IS NOT NULL
      AND (benchmark_price_raw * unit_to_bbl_factor + benchmark_adjustment_usd_bbl) > 0
      THEN ((unit_price_usd_per_bbl
             - (benchmark_price_raw * unit_to_bbl_factor + benchmark_adjustment_usd_bbl))
            / (benchmark_price_raw * unit_to_bbl_factor + benchmark_adjustment_usd_bbl))
            * 100.0
    ELSE NULL
  END AS delta_pct,
  -- Confidence: LEAST of all four sub-confidences. Floor at 0.
  GREATEST(
    LEAST(
      currency_confidence,
      value_confidence,
      COALESCE(quantity_extraction_confidence, 0.5)::numeric,
      benchmark_confidence
    ),
    0
  ) AS overall_confidence
FROM awards_with_spot;
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS award_price_deltas_award_idx
  ON award_price_deltas (award_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS award_price_deltas_supplier_idx
  ON award_price_deltas (supplier_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS award_price_deltas_country_idx
  ON award_price_deltas (buyer_country);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS award_price_deltas_confidence_idx
  ON award_price_deltas (overall_confidence)
  WHERE overall_confidence >= 0.6;
