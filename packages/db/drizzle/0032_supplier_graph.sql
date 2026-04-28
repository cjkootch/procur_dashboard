-- Supplier graph foundation — four new tables that record public
-- tender awards and the suppliers who won them. See:
--   docs/supplier-graph-brief.md (sections 4.1–4.4)
--   packages/db/src/schema/awards.ts
--   packages/db/src/schema/award-awardees.ts
--   packages/db/src/schema/supplier-aliases.ts
--   packages/db/src/schema/supplier-signals.ts
--
-- All four tables are public-domain (no companyId scoping). The
-- supplier_signals table will need tenant scoping when it starts
-- holding private behavioral data — see TENANT SCOPING TODO in the
-- supplier-signals.ts schema file.
--
-- Hand-authored to match the convention used since migration 0020.
-- Do not run drizzle-kit generate against this — snapshots are out
-- of sync (see packages/db/drizzle/README.md).

-- pg_trgm is required for the trigram GIN indexes on
-- awards.commodity_description and supplier_aliases.alias_normalized.
-- Idempotent — fine to re-run.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint

-- ─── awards ──────────────────────────────────────────────────────────
CREATE TABLE "awards" (
  "id"                       uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "source_portal"            text NOT NULL,
  "source_award_id"          text NOT NULL,
  "source_url"               text,
  "source_url_archived"      text,
  "raw_payload"              jsonb,
  "jurisdiction_id"          uuid REFERENCES "jurisdictions" ("id"),
  "agency_id"                uuid REFERENCES "agencies" ("id"),
  "opportunity_id"           uuid REFERENCES "opportunities" ("id"),
  "buyer_name"               text NOT NULL,
  "buyer_country"            text NOT NULL,
  "beneficiary_country"      text,
  "title"                    text,
  "commodity_description"    text,
  "unspsc_codes"             text[],
  "cpv_codes"                text[],
  "naics_codes"              text[],
  "category_tags"            text[],
  "contract_value_native"    numeric(20, 2),
  "contract_currency"        text,
  "contract_value_usd"       numeric(20, 2),
  "contract_duration_months" integer,
  "award_date"               date NOT NULL,
  "performance_start"        date,
  "performance_end"          date,
  "status"                   text DEFAULT 'active' NOT NULL,
  "scraped_at"               timestamp DEFAULT now() NOT NULL,
  "created_at"               timestamp DEFAULT now() NOT NULL,
  "updated_at"               timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint

CREATE UNIQUE INDEX "awards_source_uniq_idx"
  ON "awards" ("source_portal", "source_award_id");
--> statement-breakpoint
CREATE INDEX "awards_buyer_country_idx"
  ON "awards" ("buyer_country");
--> statement-breakpoint
CREATE INDEX "awards_beneficiary_country_idx"
  ON "awards" ("beneficiary_country")
  WHERE "beneficiary_country" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "awards_award_date_idx"
  ON "awards" ("award_date");
--> statement-breakpoint
CREATE INDEX "awards_value_usd_idx"
  ON "awards" ("contract_value_usd")
  WHERE "contract_value_usd" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "awards_unspsc_idx"
  ON "awards" USING gin ("unspsc_codes");
--> statement-breakpoint
CREATE INDEX "awards_cpv_idx"
  ON "awards" USING gin ("cpv_codes");
--> statement-breakpoint
CREATE INDEX "awards_category_tags_idx"
  ON "awards" USING gin ("category_tags");
--> statement-breakpoint
CREATE INDEX "awards_description_trgm_idx"
  ON "awards" USING gin ("commodity_description" gin_trgm_ops);
--> statement-breakpoint

-- ─── award_awardees ──────────────────────────────────────────────────
CREATE TABLE "award_awardees" (
  "award_id"    uuid NOT NULL REFERENCES "awards" ("id") ON DELETE CASCADE,
  "supplier_id" uuid NOT NULL REFERENCES "external_suppliers" ("id") ON DELETE CASCADE,
  "role"        text DEFAULT 'prime' NOT NULL,
  "share_pct"   numeric(5, 2),
  "created_at"  timestamp DEFAULT now() NOT NULL,
  PRIMARY KEY ("award_id", "supplier_id")
);
--> statement-breakpoint

CREATE INDEX "award_awardees_supplier_idx"
  ON "award_awardees" ("supplier_id");
--> statement-breakpoint

-- ─── supplier_aliases ────────────────────────────────────────────────
CREATE TABLE "supplier_aliases" (
  "id"               uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "supplier_id"      uuid NOT NULL REFERENCES "external_suppliers" ("id") ON DELETE CASCADE,
  "alias"            text NOT NULL,
  "alias_normalized" text NOT NULL,
  "source_portal"    text,
  "confidence"       numeric(3, 2),
  "verified"         boolean DEFAULT false NOT NULL,
  "created_at"       timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint

CREATE INDEX "supplier_aliases_normalized_trgm_idx"
  ON "supplier_aliases" USING gin ("alias_normalized" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "supplier_aliases_supplier_idx"
  ON "supplier_aliases" ("supplier_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "supplier_aliases_uniq_idx"
  ON "supplier_aliases" ("supplier_id", "alias_normalized");
--> statement-breakpoint

-- ─── supplier_signals ────────────────────────────────────────────────
-- Public-domain for v1 (no company_id column). Will need tenant
-- scoping once private behavioral data lands here — see TENANT
-- SCOPING TODO in packages/db/src/schema/supplier-signals.ts.
CREATE TABLE "supplier_signals" (
  "id"           uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "supplier_id"  uuid NOT NULL REFERENCES "external_suppliers" ("id") ON DELETE CASCADE,
  "signal_type"  text NOT NULL,
  "signal_value" jsonb NOT NULL,
  "rfq_id"       text,
  "observed_at"  timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint

CREATE INDEX "supplier_signals_supplier_observed_idx"
  ON "supplier_signals" ("supplier_id", "observed_at");
--> statement-breakpoint
CREATE INDEX "supplier_signals_type_idx"
  ON "supplier_signals" ("signal_type");
