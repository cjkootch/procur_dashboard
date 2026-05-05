-- Add company_id to apollo_credit_log so the per-tenant per-day
-- enrichment cap (default 25, per apollo-integration-brief.md §11)
-- can be enforced. Nullable — cron-driven calls (batch enrichment,
-- saved-search runner) have no tenant scope; on-demand calls from
-- entity profiles or chat tools do.

ALTER TABLE apollo_credit_log
  ADD COLUMN IF NOT EXISTS company_id uuid REFERENCES companies(id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS apollo_credit_log_company_called_at_idx
  ON apollo_credit_log (company_id, called_at);
