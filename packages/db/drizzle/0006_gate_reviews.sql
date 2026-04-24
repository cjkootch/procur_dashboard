CREATE TABLE "pursuit_gate_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pursuit_id" uuid NOT NULL,
	"stage" text NOT NULL,
	"decision" text DEFAULT 'pending' NOT NULL,
	"reviewer_user_id" uuid,
	"summary" text,
	"criteria" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "pursuit_gate_reviews" ADD CONSTRAINT "pursuit_gate_reviews_pursuit_id_pursuits_id_fk" FOREIGN KEY ("pursuit_id") REFERENCES "public"."pursuits"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pursuit_gate_reviews" ADD CONSTRAINT "pursuit_gate_reviews_reviewer_user_id_users_id_fk" FOREIGN KEY ("reviewer_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pursuit_gate_reviews_pursuit_idx" ON "pursuit_gate_reviews" USING btree ("pursuit_id");--> statement-breakpoint
CREATE INDEX "pursuit_gate_reviews_pursuit_stage_idx" ON "pursuit_gate_reviews" USING btree ("pursuit_id","stage");