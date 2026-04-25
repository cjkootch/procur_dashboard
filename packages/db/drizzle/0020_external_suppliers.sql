-- External supplier directory: organisations registered on public
-- procurement portals. Distinct from `companies` (Procur tenants).
-- Shared market data, scoped by jurisdictionId; scraper-driven.

CREATE TABLE IF NOT EXISTS "external_suppliers" (
  "id"                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "jurisdiction_id"       uuid NOT NULL REFERENCES "jurisdictions"("id"),

  "source_name"           text NOT NULL,
  "source_reference_id"   text NOT NULL,
  "source_category"       text,
  "source_url"            text,

  "organisation_name"     text NOT NULL,
  "address"               text,
  "phone"                 text,
  "email"                 text,
  "country"               text,
  "contact_person"        text,
  "registered_at"         timestamp,

  "raw_data"              jsonb,
  "first_seen_at"         timestamp NOT NULL DEFAULT now(),
  "last_seen_at"          timestamp NOT NULL DEFAULT now(),

  "created_at"            timestamp NOT NULL DEFAULT now(),
  "updated_at"            timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "ext_supplier_source_uniq_idx"
  ON "external_suppliers" ("jurisdiction_id", "source_name", "source_reference_id");

CREATE INDEX IF NOT EXISTS "ext_supplier_jurisdiction_idx"
  ON "external_suppliers" ("jurisdiction_id");

CREATE INDEX IF NOT EXISTS "ext_supplier_name_idx"
  ON "external_suppliers" ("organisation_name");
