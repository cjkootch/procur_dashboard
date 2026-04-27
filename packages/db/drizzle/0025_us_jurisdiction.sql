-- Add the US Federal jurisdiction so the SAM.gov scraper has somewhere
-- to upsert opportunities. region='global' since US federal procurement
-- spans CONUS + OCONUS embassies/bases, mirroring how UN was modeled.
-- Idempotent — `ON CONFLICT DO NOTHING` makes this safe to re-run, and
-- the seed-data.ts entry is the source of truth for fresh DBs.

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
  'United States Federal',
  'us-federal',
  'US',
  'global',
  'SAM.gov',
  'https://sam.gov',
  'sam-gov',
  'USD',
  'en',
  'America/New_York',
  true
)
ON CONFLICT (slug) DO NOTHING;
--> statement-breakpoint

-- Seed the headline US federal buying agencies that match VTC's
-- supply categories (food, fuel, vehicles, minerals). resolveAgencyId
-- in upsertOpportunity creates new rows for misses, so this just
-- primes the most common ones.
INSERT INTO "agencies" ("jurisdiction_id", "name", "short_name", "slug", "type")
SELECT j.id, agency.name, agency.short_name, agency.slug, agency.type
FROM "jurisdictions" j
CROSS JOIN (VALUES
  ('Defense Logistics Agency', 'DLA', 'defense-logistics-agency', 'agency'),
  ('U.S. Agency for International Development', 'USAID', 'usaid', 'agency'),
  ('U.S. Department of Agriculture', 'USDA', 'usda', 'ministry'),
  ('General Services Administration', 'GSA', 'gsa', 'agency'),
  ('U.S. Department of State', 'DOS', 'state-department', 'ministry'),
  ('U.S. Department of Defense', 'DOD', 'department-of-defense', 'ministry'),
  ('U.S. Department of Energy', 'DOE', 'department-of-energy', 'ministry'),
  ('U.S. Department of Veterans Affairs', 'VA', 'veterans-affairs', 'ministry'),
  ('U.S. Department of Homeland Security', 'DHS', 'homeland-security', 'ministry')
) AS agency(name, short_name, slug, type)
WHERE j.slug = 'us-federal'
ON CONFLICT (jurisdiction_id, slug) DO NOTHING;
