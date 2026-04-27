-- Private uploaded opportunities. Until now `opportunities` only held
-- public scraper-ingested tenders, identified by (jurisdiction_id,
-- source_reference_id). This adds the columns needed to also hold
-- private uploads (RFPs / RFQs a customer received off-platform) and
-- relaxes two NOT NULL constraints that don't apply to those rows.
--
-- Privacy boundary:
--   - company_id IS NULL  → public scraped opportunity (every existing row)
--   - company_id IS NOT NULL → private upload, only that company sees it
--
-- The Discover query keeps a `WHERE company_id IS NULL` filter so private
-- rows never leak into the public listing.

ALTER TABLE "opportunities"
  ADD COLUMN "company_id" uuid REFERENCES "companies"("id"),
  ADD COLUMN "source" text NOT NULL DEFAULT 'scraped',
  ADD COLUMN "uploaded_by_user_id" uuid REFERENCES "users"("id");
--> statement-breakpoint

ALTER TABLE "opportunities" ALTER COLUMN "jurisdiction_id" DROP NOT NULL;
--> statement-breakpoint

ALTER TABLE "opportunities" ALTER COLUMN "source_url" DROP NOT NULL;
--> statement-breakpoint

-- Existing unique index assumed every row had a (jurisdiction_id,
-- source_reference_id) pair. Uploaded rows have neither — recreate as
-- partial so the constraint only applies to scraped rows.
DROP INDEX IF EXISTS "opp_source_ref_idx";
--> statement-breakpoint

CREATE UNIQUE INDEX "opp_source_ref_idx"
  ON "opportunities" ("jurisdiction_id", "source_reference_id")
  WHERE "source" = 'scraped';
--> statement-breakpoint

-- Capture queries scope by company; partial index keeps it small since
-- the vast majority of rows are public (company_id IS NULL).
CREATE INDEX "opp_company_id_idx"
  ON "opportunities" ("company_id")
  WHERE "company_id" IS NOT NULL;
