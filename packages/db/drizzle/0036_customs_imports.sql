CREATE TABLE IF NOT EXISTS "customs_imports" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "source" text NOT NULL,
  "reporter_country" text NOT NULL,
  "partner_country" text NOT NULL,
  "product_code" text NOT NULL,
  "product_label" text,
  "flow_direction" text NOT NULL,
  "period" date NOT NULL,
  "period_granularity" text NOT NULL DEFAULT 'M',
  "quantity_kg" numeric(20, 2),
  "value_native" numeric(20, 2),
  "value_currency" text,
  "value_usd" numeric(20, 2),
  "raw_payload" jsonb,
  "ingested_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "customs_imports_source_uniq_idx"
  ON "customs_imports" ("source", "reporter_country", "partner_country", "product_code", "flow_direction", "period");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "customs_imports_partner_product_idx"
  ON "customs_imports" ("partner_country", "product_code", "period");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "customs_imports_reporter_product_idx"
  ON "customs_imports" ("reporter_country", "product_code", "period");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "customs_imports_period_idx"
  ON "customs_imports" ("period");
