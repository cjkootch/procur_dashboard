CREATE TABLE "pricing_line_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pricing_model_id" uuid NOT NULL,
	"clin_number" text,
	"title" text NOT NULL,
	"category" text DEFAULT 'other' NOT NULL,
	"quantity" numeric(14, 4),
	"unit_of_measure" text,
	"unit_price" numeric(14, 4),
	"amount" numeric(20, 2),
	"start_date" text,
	"end_date" text,
	"notes" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pricing_line_items" ADD CONSTRAINT "pricing_line_items_pricing_model_id_pricing_models_id_fk" FOREIGN KEY ("pricing_model_id") REFERENCES "public"."pricing_models"("id") ON DELETE cascade ON UPDATE no action;