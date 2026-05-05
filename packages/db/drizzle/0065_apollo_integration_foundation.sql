-- Apollo.io integration foundation (Day 1 of build per
-- docs/apollo-integration-brief.md). Adds:
--   - primary_domain on known_entities + external_suppliers (the
--     identity key any external corporate-data API joins on; not
--     Apollo-specific)
--   - Apollo cache columns: apollo_org_id, apollo_synced_at, plus
--     queryable funding/headcount/revenue fields and a wide
--     apollo_snapshot jsonb for rarely-queried data (24-month
--     employee_metrics, technology stack, per-round funding events)
--   - apollo_saved_searches table for tenant-scoped discovery alerts
--   - apollo_credit_log table for measuring monthly burn against
--     the Apollo plan
--
-- No service code yet — this migration is structural. The
-- @procur/apollo package skeleton lands alongside but does not
-- call the Apollo API. APOLLO_ENABLED defaults to false.
--
-- Forward-only: existing rows get NULL primary_domain + NULL
-- apollo_* fields and stay unmatched until the nightly batch job
-- runs (lands in a later migration / PR).

ALTER TABLE known_entities
  ADD COLUMN IF NOT EXISTS primary_domain text;
--> statement-breakpoint

ALTER TABLE known_entities
  ADD COLUMN IF NOT EXISTS apollo_org_id text;
--> statement-breakpoint

ALTER TABLE known_entities
  ADD COLUMN IF NOT EXISTS apollo_synced_at timestamp;
--> statement-breakpoint

ALTER TABLE known_entities
  ADD COLUMN IF NOT EXISTS apollo_funding_stage text;
--> statement-breakpoint

ALTER TABLE known_entities
  ADD COLUMN IF NOT EXISTS apollo_total_funding bigint;
--> statement-breakpoint

ALTER TABLE known_entities
  ADD COLUMN IF NOT EXISTS apollo_latest_funding_at date;
--> statement-breakpoint

ALTER TABLE known_entities
  ADD COLUMN IF NOT EXISTS apollo_estimated_employees integer;
--> statement-breakpoint

ALTER TABLE known_entities
  ADD COLUMN IF NOT EXISTS apollo_annual_revenue bigint;
--> statement-breakpoint

ALTER TABLE known_entities
  ADD COLUMN IF NOT EXISTS apollo_snapshot jsonb;
--> statement-breakpoint

ALTER TABLE external_suppliers
  ADD COLUMN IF NOT EXISTS primary_domain text;
--> statement-breakpoint

ALTER TABLE external_suppliers
  ADD COLUMN IF NOT EXISTS apollo_org_id text;
--> statement-breakpoint

ALTER TABLE external_suppliers
  ADD COLUMN IF NOT EXISTS apollo_synced_at timestamp;
--> statement-breakpoint

ALTER TABLE external_suppliers
  ADD COLUMN IF NOT EXISTS apollo_funding_stage text;
--> statement-breakpoint

ALTER TABLE external_suppliers
  ADD COLUMN IF NOT EXISTS apollo_total_funding bigint;
--> statement-breakpoint

ALTER TABLE external_suppliers
  ADD COLUMN IF NOT EXISTS apollo_latest_funding_at date;
--> statement-breakpoint

ALTER TABLE external_suppliers
  ADD COLUMN IF NOT EXISTS apollo_estimated_employees integer;
--> statement-breakpoint

ALTER TABLE external_suppliers
  ADD COLUMN IF NOT EXISTS apollo_annual_revenue bigint;
--> statement-breakpoint

ALTER TABLE external_suppliers
  ADD COLUMN IF NOT EXISTS apollo_snapshot jsonb;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS known_entities_primary_domain_idx
  ON known_entities (primary_domain);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS known_entities_apollo_org_id_idx
  ON known_entities (apollo_org_id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS known_entities_apollo_funding_stage_idx
  ON known_entities (apollo_funding_stage);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS known_entities_apollo_latest_funding_at_idx
  ON known_entities (apollo_latest_funding_at);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS external_suppliers_primary_domain_idx
  ON external_suppliers (primary_domain);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS external_suppliers_apollo_org_id_idx
  ON external_suppliers (apollo_org_id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS external_suppliers_apollo_funding_stage_idx
  ON external_suppliers (apollo_funding_stage);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS external_suppliers_apollo_latest_funding_at_idx
  ON external_suppliers (apollo_latest_funding_at);
--> statement-breakpoint

-- Tenant-scoped saved searches that fire as alerts when new orgs
-- match the saved filters. Apollo credentials are global (single
-- master key); the saved queries are per-tenant because they encode
-- commercial intent.
CREATE TABLE IF NOT EXISTS apollo_saved_searches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id),
  name text NOT NULL,
  description text,
  search_filters jsonb NOT NULL,
  alert_mode text NOT NULL DEFAULT 'on-new-match',
  schedule text NOT NULL DEFAULT 'daily',
  last_seen_org_ids text[] NOT NULL DEFAULT '{}'::text[],
  last_run_at timestamp,
  status text NOT NULL DEFAULT 'active',
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS apollo_saved_searches_company_idx
  ON apollo_saved_searches (company_id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS apollo_saved_searches_status_idx
  ON apollo_saved_searches (status);
--> statement-breakpoint

-- One row per Apollo API call. Used to measure monthly credit burn
-- against the plan and tune freshness windows. Not user-facing;
-- powers the admin observability page.
CREATE TABLE IF NOT EXISTS apollo_credit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  endpoint text NOT NULL,
  args_hash text,
  page integer,
  per_page integer,
  http_status integer,
  credits_spent integer,
  duration_ms integer,
  error_code text,
  notes text,
  called_at timestamp NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS apollo_credit_log_called_at_idx
  ON apollo_credit_log (called_at);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS apollo_credit_log_endpoint_idx
  ON apollo_credit_log (endpoint);
