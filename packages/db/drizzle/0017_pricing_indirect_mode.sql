-- Per-pricing-model indirect rate mode. NULL not allowed — defaults to
-- 'multiplicative' so existing rows match prior runtime behavior. The
-- indirect-rate UI on the pricer reads + writes this; pricer-math
-- summarize() picks multiplicative vs additive based on the value.

ALTER TABLE "pricing_models" ADD COLUMN "indirect_rate_mode" text DEFAULT 'multiplicative' NOT NULL;
