CREATE TABLE IF NOT EXISTS "commodity_benchmark_mappings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "category_tag" text NOT NULL,
  "country_code" text NOT NULL,
  "grade" text,
  "benchmark_slug" text NOT NULL,
  "benchmark_source" text NOT NULL,
  "benchmark_adjustment_usd_bbl" numeric(8, 4),
  "notes" text,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "commodity_benchmark_mappings_uniq_idx"
  ON "commodity_benchmark_mappings" ("category_tag", "country_code", "grade");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "commodity_benchmark_mappings_category_idx"
  ON "commodity_benchmark_mappings" ("category_tag");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "country_default_currencies" (
  "country_code" text PRIMARY KEY NOT NULL,
  "default_currency" text NOT NULL,
  "notes" text,
  "updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "fx_rates" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "currency_code" text NOT NULL,
  "rate_date" date NOT NULL,
  "rate_to_usd" numeric(18, 8) NOT NULL,
  "source" text NOT NULL,
  "ingested_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "fx_rates_currency_date_uniq_idx"
  ON "fx_rates" ("currency_code", "rate_date");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fx_rates_date_idx" ON "fx_rates" ("rate_date");
