CREATE TABLE "company_capabilities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"category" text DEFAULT 'service' NOT NULL,
	"description" text,
	"evidence_url" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pursuit_capability_requirements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pursuit_id" uuid NOT NULL,
	"requirement" text NOT NULL,
	"priority" text DEFAULT 'must' NOT NULL,
	"coverage" text DEFAULT 'not_assessed' NOT NULL,
	"capability_id" uuid,
	"notes" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "company_capabilities" ADD CONSTRAINT "company_capabilities_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pursuit_capability_requirements" ADD CONSTRAINT "pursuit_capability_requirements_pursuit_id_pursuits_id_fk" FOREIGN KEY ("pursuit_id") REFERENCES "public"."pursuits"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pursuit_capability_requirements" ADD CONSTRAINT "pursuit_capability_requirements_capability_id_company_capabilities_id_fk" FOREIGN KEY ("capability_id") REFERENCES "public"."company_capabilities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "company_capabilities_company_idx" ON "company_capabilities" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "pursuit_capability_requirements_pursuit_idx" ON "pursuit_capability_requirements" USING btree ("pursuit_id");
