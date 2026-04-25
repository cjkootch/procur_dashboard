-- Per-tenant override for the monthly AI budget cap. NULL means "use the
-- plan-tier default" — see MONTHLY_BUDGET_CENTS in @procur/ai assistant/
-- budget.ts. Used by the admin app (apps/admin/app/tenants/[id]) so ops
-- can tune individual tenants without a deploy.

ALTER TABLE "companies" ADD COLUMN "monthly_ai_budget_cents" integer;
