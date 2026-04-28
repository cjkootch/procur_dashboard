-- Beneficiary country: free-text column for "where the work is" /
-- "who benefits from the procurement", distinct from the jurisdiction
-- column which represents the portal/source.
--
-- Use case: UN notices (jurisdiction=un, UNGM portal) have actual
-- target countries (Suriname, Colombia, etc). For Discover, we want
-- a filter that surfaces "all opportunities for Suriname" regardless
-- of source. National portals (Jamaica/Trinidad/etc) leave this null —
-- they ARE the beneficiary; the existing jurisdiction filter handles them.

ALTER TABLE "opportunities"
  ADD COLUMN "beneficiary_country" text;
--> statement-breakpoint

-- Partial index: most rows leave beneficiary_country null, so a partial
-- index keeps it small while still serving the filter dropdown query
-- (`SELECT DISTINCT beneficiary_country WHERE beneficiary_country IS NOT NULL`).
CREATE INDEX "opp_beneficiary_country_idx"
  ON "opportunities" ("beneficiary_country")
  WHERE "beneficiary_country" IS NOT NULL;
