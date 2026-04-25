-- Backfill indexes on tables that were missing them. The contracts table
-- has been live since the initial migration with no indexes; every
-- contract-list and report query was a full table scan filtered in
-- memory. Same pattern on past_performance.
--
-- audit_log already has (entity_type, entity_id) but the pursuit-detail
-- page also orders by created_at DESC, so we add a tail-of-tuple sort
-- order helper.

CREATE INDEX IF NOT EXISTS "contracts_company_idx" ON "contracts" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "contracts_pursuit_idx" ON "contracts" USING btree ("pursuit_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "contracts_parent_idx" ON "contracts" USING btree ("parent_contract_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "past_performance_company_idx" ON "past_performance" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "proposal_shreds_proposal_sort_idx" ON "proposal_shreds" USING btree ("proposal_id","sort_order");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "proposals_pursuit_updated_idx" ON "proposals" USING btree ("pursuit_id","updated_at");
