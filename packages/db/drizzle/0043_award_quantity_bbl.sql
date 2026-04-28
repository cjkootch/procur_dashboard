ALTER TABLE "awards" ADD COLUMN IF NOT EXISTS "quantity_bbl" numeric(20, 4);
--> statement-breakpoint
ALTER TABLE "awards" ADD COLUMN IF NOT EXISTS "quantity_extraction_method" text;
--> statement-breakpoint
ALTER TABLE "awards" ADD COLUMN IF NOT EXISTS "quantity_extraction_confidence" numeric(3, 2);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "awards_quantity_bbl_idx" ON "awards" ("quantity_bbl") WHERE "quantity_bbl" IS NOT NULL;
