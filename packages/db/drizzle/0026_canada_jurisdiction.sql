-- Add the Canadian Federal jurisdiction so the CanadaBuys scraper has
-- somewhere to upsert opportunities. region='global' since Canadian
-- federal procurement spans CONUS-equivalent + overseas missions, same
-- modeling as us-federal. Idempotent — `ON CONFLICT DO NOTHING` makes
-- this safe to re-run, and the seed-data.ts entry is the source of
-- truth for fresh DBs.

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
  'Canada Federal',
  'canada-federal',
  'CA',
  'global',
  'CanadaBuys',
  'https://canadabuys.canada.ca',
  'canada-buys',
  'CAD',
  'en',
  'America/Toronto',
  true
)
ON CONFLICT (slug) DO NOTHING;
--> statement-breakpoint

-- Seed the headline Canadian federal buying entities matching VTC's
-- supply categories. resolveAgencyId in upsertOpportunity creates new
-- rows for misses, so this just primes the most common ones.
INSERT INTO "agencies" ("jurisdiction_id", "name", "short_name", "slug", "type")
SELECT j.id, agency.name, agency.short_name, agency.slug, agency.type
FROM "jurisdictions" j
CROSS JOIN (VALUES
  ('Public Services and Procurement Canada', 'PSPC', 'pspc', 'agency'),
  ('Department of National Defence', 'DND', 'dnd', 'ministry'),
  ('Canadian Food Inspection Agency', 'CFIA', 'cfia', 'agency'),
  ('Agriculture and Agri-Food Canada', 'AAFC', 'aafc', 'ministry'),
  ('Natural Resources Canada', 'NRCan', 'nrcan', 'ministry'),
  ('Global Affairs Canada', 'GAC', 'gac', 'ministry'),
  ('Royal Canadian Mounted Police', 'RCMP', 'rcmp', 'agency'),
  ('Canada Border Services Agency', 'CBSA', 'cbsa', 'agency'),
  ('Transport Canada', 'TC', 'transport-canada', 'ministry'),
  ('Indigenous Services Canada', 'ISC', 'isc', 'ministry')
) AS agency(name, short_name, slug, type)
WHERE j.slug = 'canada-federal'
ON CONFLICT (jurisdiction_id, slug) DO NOTHING;
