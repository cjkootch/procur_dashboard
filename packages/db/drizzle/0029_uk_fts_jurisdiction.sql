-- Add the UK Find a Tender Service (FTS) jurisdiction so the
-- UkFtsScraper has somewhere to upsert opportunities. region='global'
-- since UK procurement spans CONUS-equivalent + overseas operations
-- (Gibraltar, Cyprus SBAs, Falklands, BIOT, etc.) — same modeling
-- as us-federal and eu-ted. Idempotent — safe to re-run.

INSERT INTO "jurisdictions" (
  "name",
  "slug",
  "country_code",
  "region",
  "portal_name",
  "portal_url",
  "scraper_module",
  "currency",
  "language",
  "timezone",
  "active"
) VALUES (
  'United Kingdom',
  'uk-fts',
  'GB',
  'global',
  'Find a Tender Service',
  'https://www.find-tender.service.gov.uk',
  'uk-fts',
  'GBP',
  'en',
  'Europe/London',
  true
)
ON CONFLICT (slug) DO NOTHING;
--> statement-breakpoint

-- Seed the headline UK federal buying entities most relevant to VTC's
-- supply categories (overseas operations, defence subsistence and fuel).
-- resolveAgencyId in upsertOpportunity creates rows for misses.
INSERT INTO "agencies" ("jurisdiction_id", "name", "short_name", "slug", "type")
SELECT j.id, agency.name, agency.short_name, agency.slug, agency.type
FROM "jurisdictions" j
CROSS JOIN (VALUES
  ('Ministry of Defence', 'MoD', 'mod', 'ministry'),
  ('Defence Equipment and Support', 'DE&S', 'des', 'agency'),
  ('UK Strategic Command', 'UKStratCom', 'ukstratcom', 'agency'),
  ('Department for Business and Trade', 'DBT', 'dbt', 'ministry'),
  ('Foreign Commonwealth and Development Office', 'FCDO', 'fcdo', 'ministry'),
  ('Cabinet Office', 'CO', 'cabinet-office', 'ministry'),
  ('Crown Commercial Service', 'CCS', 'ccs', 'agency'),
  ('Department of Health and Social Care', 'DHSC', 'dhsc', 'ministry'),
  ('Home Office', 'HO', 'home-office', 'ministry'),
  ('NHS Supply Chain', 'NHS-SC', 'nhs-supply-chain', 'agency')
) AS agency(name, short_name, slug, type)
WHERE j.slug = 'uk-fts'
ON CONFLICT (jurisdiction_id, slug) DO NOTHING;
