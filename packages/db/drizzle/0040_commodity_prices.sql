CREATE TABLE IF NOT EXISTS "commodity_prices" (
  "id" serial PRIMARY KEY NOT NULL,
  "series_slug" text NOT NULL,
  "contract_type" text DEFAULT 'spot' NOT NULL,
  "source" text NOT NULL,
  "price_date" date NOT NULL,
  "price" numeric NOT NULL,
  "unit" text DEFAULT 'usd-bbl' NOT NULL,
  "metadata" jsonb,
  "created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "commodity_prices_uniq_idx"
  ON "commodity_prices" ("series_slug", "contract_type", "price_date");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "commodity_prices_series_date_idx"
  ON "commodity_prices" ("series_slug", "price_date");
