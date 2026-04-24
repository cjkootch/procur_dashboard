CREATE TABLE "pursuit_team_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pursuit_id" uuid NOT NULL,
	"partner_name" text NOT NULL,
	"role" text DEFAULT 'subcontractor' NOT NULL,
	"status" text DEFAULT 'engaging' NOT NULL,
	"allocation_pct" numeric(5, 2),
	"capabilities" text,
	"contact_name" text,
	"contact_email" text,
	"notes" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pursuit_team_members" ADD CONSTRAINT "pursuit_team_members_pursuit_id_pursuits_id_fk" FOREIGN KEY ("pursuit_id") REFERENCES "public"."pursuits"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pursuit_team_members_pursuit_idx" ON "pursuit_team_members" USING btree ("pursuit_id");
