CREATE TYPE "public"."alert_frequency" AS ENUM('instant', 'daily', 'weekly');--> statement-breakpoint
CREATE TYPE "public"."contract_status" AS ENUM('active', 'completed', 'terminated');--> statement-breakpoint
CREATE TYPE "public"."contract_tier" AS ENUM('prime', 'subcontract', 'task_order');--> statement-breakpoint
CREATE TYPE "public"."opportunity_status" AS ENUM('active', 'closed', 'awarded', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."plan_tier" AS ENUM('free', 'pro', 'team', 'enterprise');--> statement-breakpoint
CREATE TYPE "public"."proposal_status" AS ENUM('drafting', 'outline_ready', 'in_review', 'finalized', 'submitted');--> statement-breakpoint
CREATE TYPE "public"."pursuit_stage" AS ENUM('identification', 'qualification', 'capture_planning', 'proposal_development', 'submitted', 'awarded', 'lost');--> statement-breakpoint
CREATE TYPE "public"."region" AS ENUM('caribbean', 'latam', 'africa', 'global');--> statement-breakpoint
CREATE TYPE "public"."scraper_run_status" AS ENUM('running', 'success', 'failed', 'partial');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('owner', 'admin', 'member', 'viewer');--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clerk_id" text NOT NULL,
	"email" text NOT NULL,
	"first_name" text,
	"last_name" text,
	"image_url" text,
	"company_id" uuid,
	"role" "user_role" DEFAULT 'member' NOT NULL,
	"preferences" jsonb,
	"last_active_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "users_clerk_id_unique" UNIQUE("clerk_id")
);
--> statement-breakpoint
CREATE TABLE "companies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clerk_org_id" text NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"logo_url" text,
	"website_url" text,
	"country" text,
	"industry" text,
	"year_founded" integer,
	"employee_count" integer,
	"annual_revenue" text,
	"capabilities" text[],
	"preferred_jurisdictions" text[],
	"preferred_categories" text[],
	"target_contract_size_min" integer,
	"target_contract_size_max" integer,
	"plan_tier" "plan_tier" DEFAULT 'free' NOT NULL,
	"stripe_customer_id" text,
	"stripe_subscription_id" text,
	"subscription_status" text,
	"trial_ends_at" timestamp,
	"onboarding_completed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "companies_clerk_org_id_unique" UNIQUE("clerk_org_id"),
	CONSTRAINT "companies_slug_unique" UNIQUE("slug"),
	CONSTRAINT "companies_stripe_customer_id_unique" UNIQUE("stripe_customer_id")
);
--> statement-breakpoint
CREATE TABLE "jurisdictions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"country_code" text NOT NULL,
	"region" "region" NOT NULL,
	"portal_name" text,
	"portal_url" text,
	"scraper_module" text,
	"currency" text,
	"language" text DEFAULT 'en',
	"timezone" text,
	"active" boolean DEFAULT true NOT NULL,
	"last_successful_scrape_at" timestamp,
	"consecutive_failures" integer DEFAULT 0,
	"opportunities_count" integer DEFAULT 0,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "jurisdictions_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "agencies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"jurisdiction_id" uuid NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"short_name" text,
	"type" text,
	"parent_agency_id" uuid,
	"website_url" text,
	"opportunities_count" integer DEFAULT 0,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "opportunities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_reference_id" text NOT NULL,
	"jurisdiction_id" uuid NOT NULL,
	"agency_id" uuid,
	"source_url" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"reference_number" text,
	"type" text,
	"category" text,
	"sub_category" text,
	"naics_code" text,
	"cpv_code" text,
	"tags" text[],
	"value_estimate" numeric(20, 2),
	"value_min" numeric(20, 2),
	"value_max" numeric(20, 2),
	"currency" text DEFAULT 'USD',
	"value_estimate_usd" numeric(20, 2),
	"published_at" timestamp,
	"deadline_at" timestamp,
	"deadline_timezone" text,
	"pre_bid_meeting_at" timestamp,
	"clarification_deadline_at" timestamp,
	"raw_content" jsonb,
	"parsed_content" jsonb,
	"extracted_requirements" jsonb,
	"extracted_criteria" jsonb,
	"mandatory_documents" jsonb,
	"ai_summary" text,
	"ai_category_confidence" numeric(3, 2),
	"extraction_confidence" numeric(3, 2),
	"status" "opportunity_status" DEFAULT 'active' NOT NULL,
	"awarded_to_company_name" text,
	"awarded_amount" numeric(20, 2),
	"awarded_at" timestamp,
	"language" text DEFAULT 'en',
	"slug" text,
	"search_vector" "tsvector",
	"first_seen_at" timestamp DEFAULT now(),
	"last_seen_at" timestamp DEFAULT now(),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "opportunities_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"opportunity_id" uuid,
	"document_type" text NOT NULL,
	"title" text,
	"original_url" text NOT NULL,
	"r2_key" text,
	"r2_url" text,
	"extracted_text" text,
	"extracted_structure" jsonb,
	"ocr_applied" boolean DEFAULT false,
	"processing_status" text DEFAULT 'pending',
	"processing_error" text,
	"page_count" integer,
	"file_size" integer,
	"mime_type" text,
	"language" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pursuits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"opportunity_id" uuid NOT NULL,
	"stage" "pursuit_stage" DEFAULT 'identification' NOT NULL,
	"bid_decision" text,
	"bid_decision_reasoning" text,
	"bid_decision_at" timestamp,
	"p_win" numeric(3, 2),
	"weighted_value" numeric(20, 2),
	"capture_answers" jsonb,
	"assigned_user_id" uuid,
	"capture_manager_id" uuid,
	"submitted_at" timestamp,
	"submitted_value" numeric(20, 2),
	"outcome_notified_at" timestamp,
	"won_at" timestamp,
	"lost_at" timestamp,
	"outcome_reasoning" text,
	"notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pursuit_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pursuit_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"due_date" date,
	"completed_at" timestamp,
	"assigned_user_id" uuid,
	"priority" text DEFAULT 'medium',
	"category" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pursuit_id" uuid NOT NULL,
	"status" "proposal_status" DEFAULT 'drafting' NOT NULL,
	"outline" jsonb,
	"compliance_matrix" jsonb,
	"sections" jsonb,
	"latest_word_export_r2_key" text,
	"latest_word_export_url" text,
	"latest_pdf_export_r2_key" text,
	"latest_pdf_export_url" text,
	"submitted_at" timestamp,
	"submitted_by" uuid,
	"submission_confirmation" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "proposals_pursuit_id_unique" UNIQUE("pursuit_id")
);
--> statement-breakpoint
CREATE TABLE "labor_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pricing_model_id" uuid NOT NULL,
	"title" text NOT NULL,
	"type" text,
	"direct_rate" numeric(10, 2),
	"loaded_rate" numeric(10, 2),
	"hours_per_year" integer,
	"yearly_breakdown" jsonb,
	"total_cost" numeric(20, 2),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pricing_models" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pursuit_id" uuid NOT NULL,
	"pricing_strategy" text NOT NULL,
	"base_period_months" integer,
	"option_years" integer DEFAULT 0,
	"escalation_rate" numeric(5, 2) DEFAULT '0',
	"hours_per_fte" integer DEFAULT 2080,
	"government_estimate" numeric(20, 2),
	"ceiling_value" numeric(20, 2),
	"target_value" numeric(20, 2),
	"target_fee_pct" numeric(5, 2),
	"fringe_rate" numeric(5, 2),
	"overhead_rate" numeric(5, 2),
	"ga_rate" numeric(5, 2),
	"wrap_rate" numeric(5, 2),
	"currency" text DEFAULT 'USD',
	"fx_rate_to_usd" numeric(10, 4),
	"notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "pricing_models_pursuit_id_unique" UNIQUE("pursuit_id")
);
--> statement-breakpoint
CREATE TABLE "contracts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"pursuit_id" uuid,
	"award_title" text NOT NULL,
	"tier" "contract_tier" DEFAULT 'prime' NOT NULL,
	"parent_contract_id" uuid,
	"contract_number" text,
	"parent_contract_number" text,
	"task_order_number" text,
	"subcontract_number" text,
	"awarding_agency" text,
	"prime_contractor" text,
	"award_date" date,
	"start_date" date,
	"end_date" date,
	"total_value" numeric(20, 2),
	"currency" text DEFAULT 'USD',
	"total_value_usd" numeric(20, 2),
	"contract_document_url" text,
	"pws_sow_document_url" text,
	"status" "contract_status" DEFAULT 'active' NOT NULL,
	"obligations" jsonb,
	"notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "content_library" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"content" text NOT NULL,
	"structured_content" jsonb,
	"metadata" jsonb,
	"tags" text[],
	"embedding" vector(1536),
	"last_used_at" timestamp,
	"use_count" integer DEFAULT 0,
	"version" integer DEFAULT 1,
	"previous_version_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "past_performance" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_name" text NOT NULL,
	"customer_name" text NOT NULL,
	"customer_type" text,
	"period_start" date,
	"period_end" date,
	"total_value" numeric(20, 2),
	"currency" text DEFAULT 'USD',
	"scope_description" text NOT NULL,
	"key_accomplishments" text[],
	"challenges" text,
	"outcomes" text,
	"reference_name" text,
	"reference_title" text,
	"reference_email" text,
	"reference_phone" text,
	"naics_codes" text[],
	"categories" text[],
	"keywords" text[],
	"embedding" vector(1536),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "alert_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"company_id" uuid,
	"name" text NOT NULL,
	"jurisdictions" text[],
	"categories" text[],
	"keywords" text[],
	"exclude_keywords" text[],
	"min_value" numeric,
	"max_value" numeric,
	"frequency" "alert_frequency" DEFAULT 'daily' NOT NULL,
	"email_enabled" boolean DEFAULT true NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"last_sent_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "saved_opportunities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"opportunity_id" uuid NOT NULL,
	"notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scraper_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"jurisdiction_id" uuid NOT NULL,
	"started_at" timestamp NOT NULL,
	"completed_at" timestamp,
	"duration_ms" integer,
	"status" "scraper_run_status" NOT NULL,
	"records_found" integer DEFAULT 0,
	"records_new" integer DEFAULT 0,
	"records_updated" integer DEFAULT 0,
	"records_skipped" integer DEFAULT 0,
	"errors" jsonb,
	"log_output" text,
	"trigger_run_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid,
	"user_id" uuid,
	"action" text NOT NULL,
	"entity_type" text,
	"entity_id" uuid,
	"changes" jsonb,
	"metadata" jsonb,
	"ip_address" text,
	"user_agent" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "taxonomy_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"parent_slug" text,
	"description" text,
	"sort_order" integer DEFAULT 0,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "taxonomy_categories_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agencies" ADD CONSTRAINT "agencies_jurisdiction_id_jurisdictions_id_fk" FOREIGN KEY ("jurisdiction_id") REFERENCES "public"."jurisdictions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agencies" ADD CONSTRAINT "agencies_parent_agency_id_agencies_id_fk" FOREIGN KEY ("parent_agency_id") REFERENCES "public"."agencies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_jurisdiction_id_jurisdictions_id_fk" FOREIGN KEY ("jurisdiction_id") REFERENCES "public"."jurisdictions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_agency_id_agencies_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agencies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_opportunity_id_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."opportunities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pursuits" ADD CONSTRAINT "pursuits_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pursuits" ADD CONSTRAINT "pursuits_opportunity_id_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."opportunities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pursuits" ADD CONSTRAINT "pursuits_assigned_user_id_users_id_fk" FOREIGN KEY ("assigned_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pursuits" ADD CONSTRAINT "pursuits_capture_manager_id_users_id_fk" FOREIGN KEY ("capture_manager_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pursuit_tasks" ADD CONSTRAINT "pursuit_tasks_pursuit_id_pursuits_id_fk" FOREIGN KEY ("pursuit_id") REFERENCES "public"."pursuits"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pursuit_tasks" ADD CONSTRAINT "pursuit_tasks_assigned_user_id_users_id_fk" FOREIGN KEY ("assigned_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_pursuit_id_pursuits_id_fk" FOREIGN KEY ("pursuit_id") REFERENCES "public"."pursuits"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_submitted_by_users_id_fk" FOREIGN KEY ("submitted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "labor_categories" ADD CONSTRAINT "labor_categories_pricing_model_id_pricing_models_id_fk" FOREIGN KEY ("pricing_model_id") REFERENCES "public"."pricing_models"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pricing_models" ADD CONSTRAINT "pricing_models_pursuit_id_pursuits_id_fk" FOREIGN KEY ("pursuit_id") REFERENCES "public"."pursuits"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_pursuit_id_pursuits_id_fk" FOREIGN KEY ("pursuit_id") REFERENCES "public"."pursuits"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_parent_contract_id_contracts_id_fk" FOREIGN KEY ("parent_contract_id") REFERENCES "public"."contracts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_library" ADD CONSTRAINT "content_library_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "past_performance" ADD CONSTRAINT "past_performance_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_profiles" ADD CONSTRAINT "alert_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_profiles" ADD CONSTRAINT "alert_profiles_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_opportunities" ADD CONSTRAINT "saved_opportunities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_opportunities" ADD CONSTRAINT "saved_opportunities_opportunity_id_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."opportunities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scraper_runs" ADD CONSTRAINT "scraper_runs_jurisdiction_id_jurisdictions_id_fk" FOREIGN KEY ("jurisdiction_id") REFERENCES "public"."jurisdictions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agency_jur_slug_idx" ON "agencies" USING btree ("jurisdiction_id","slug");--> statement-breakpoint
CREATE UNIQUE INDEX "opp_source_ref_idx" ON "opportunities" USING btree ("jurisdiction_id","source_reference_id");--> statement-breakpoint
CREATE UNIQUE INDEX "opp_slug_idx" ON "opportunities" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "opp_deadline_idx" ON "opportunities" USING btree ("deadline_at");--> statement-breakpoint
CREATE INDEX "opp_status_idx" ON "opportunities" USING btree ("status");--> statement-breakpoint
CREATE INDEX "opp_jur_status_idx" ON "opportunities" USING btree ("jurisdiction_id","status");--> statement-breakpoint
CREATE INDEX "opp_search_idx" ON "opportunities" USING gin ("search_vector");--> statement-breakpoint
CREATE UNIQUE INDEX "pursuit_company_opp_idx" ON "pursuits" USING btree ("company_id","opportunity_id");--> statement-breakpoint
CREATE INDEX "pursuit_stage_idx" ON "pursuits" USING btree ("stage");--> statement-breakpoint
CREATE INDEX "pursuit_company_stage_idx" ON "pursuits" USING btree ("company_id","stage");--> statement-breakpoint
CREATE INDEX "task_pursuit_idx" ON "pursuit_tasks" USING btree ("pursuit_id");--> statement-breakpoint
CREATE INDEX "task_due_date_idx" ON "pursuit_tasks" USING btree ("due_date");--> statement-breakpoint
CREATE INDEX "content_lib_company_type_idx" ON "content_library" USING btree ("company_id","type");--> statement-breakpoint
CREATE INDEX "content_lib_embedding_idx" ON "content_library" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "saved_user_opp_idx" ON "saved_opportunities" USING btree ("user_id","opportunity_id");--> statement-breakpoint
CREATE INDEX "scraper_run_jur_idx" ON "scraper_runs" USING btree ("jurisdiction_id");--> statement-breakpoint
CREATE INDEX "scraper_run_started_idx" ON "scraper_runs" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX "audit_company_idx" ON "audit_log" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "audit_entity_idx" ON "audit_log" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "audit_created_idx" ON "audit_log" USING btree ("created_at");