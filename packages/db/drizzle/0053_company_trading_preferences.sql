-- Per-company trading preferences for the deal-economics calculator.
--
-- The compose_deal_economics tool currently runs against hard-coded
-- defaults (4% min gross margin, $0.02/USG min net margin, $0
-- monthly overhead, NYH-spot fallback for productCost). Those
-- defaults are reasonable for a generic trader but wrong for any
-- specific desk:
--   - VTC's typical Med-origin clean-product flow should default
--     productCost to Brent + crack, not NYH spot.
--   - A desk with a $200k/month opex line should see net-margin
--     numbers that subtract real overhead, not assume $0.
--   - Min-margin thresholds vary by desk — some tolerate 2% gross,
--     others won't bid below 6%.
--
-- All four columns are nullable. NULL preserves the existing
-- calculator default (back-compat). The settings UI populates them
-- and the compose_deal_economics tool handler merges them as
-- defaults into the input before running the calculator (the input
-- still wins per call so the user can override on a per-deal basis).

-- default_sourcing_region matches the FreightOriginRegion enum in
-- packages/catalog/src/freight-routes.ts: med | nwe | usgc |
-- singapore | mideast | india | west-africa | east-africa |
-- black-sea. Not enforced as a Postgres enum because the canonical
-- list lives in TypeScript and we want to add origins without a
-- migration.
--
-- Note: each statement in this file is separated by a drizzle
-- breakpoint marker (the literal token must NOT appear inside any
-- comment, since migrate.ts splits the file on that exact string).

ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS default_sourcing_region text,
  ADD COLUMN IF NOT EXISTS target_gross_margin_pct numeric,
  ADD COLUMN IF NOT EXISTS target_net_margin_per_usg numeric,
  ADD COLUMN IF NOT EXISTS monthly_fixed_overhead_usd_default integer;
--> statement-breakpoint

COMMENT ON COLUMN companies.default_sourcing_region IS
  'Default cargo origin for compose_deal_economics. Used as the productCost-fallback selector when the per-call sourcingRegion is omitted. Free text; canonical values in @procur/catalog FreightOriginRegion.';
--> statement-breakpoint

COMMENT ON COLUMN companies.target_gross_margin_pct IS
  'Desk-level minimum gross margin (decimal, e.g. 0.05 = 5%). Feeds thresholds.minGrossMarginPct in the fuel-deal calculator. NULL → default 0.04.';
--> statement-breakpoint

COMMENT ON COLUMN companies.target_net_margin_per_usg IS
  'Desk-level minimum net margin per US gallon (USD). Feeds thresholds.minNetMarginPerUsg. NULL → default 0.02.';
--> statement-breakpoint

COMMENT ON COLUMN companies.monthly_fixed_overhead_usd_default IS
  'Default monthly fixed overhead (USD) allocated to deal-economics runs when the per-call value is omitted. NULL → 0.';
