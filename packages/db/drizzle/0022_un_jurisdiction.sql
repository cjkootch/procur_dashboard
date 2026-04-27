-- Add the United Nations jurisdiction so the UNGM scraper has somewhere
-- to upsert opportunities. Idempotent — `ON CONFLICT DO NOTHING` makes
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
  'United Nations',
  'un',
  'UN',
  'global',
  'UN Global Marketplace (UNGM)',
  'https://www.ungm.org',
  'ungm',
  'USD',
  'en',
  'UTC',
  true
)
ON CONFLICT (slug) DO NOTHING;
--> statement-breakpoint

-- Seed the headline UN agencies so notices upsert into a real agency
-- row. resolveAgencyId in upsertOpportunity will create new rows for
-- agencies we miss here (e.g. "International Maritime Organization");
-- this just primes the most common ones.
INSERT INTO "agencies" ("jurisdiction_id", "name", "short_name", "slug", "type")
SELECT j.id, agency.name, agency.short_name, agency.slug, agency.type
FROM "jurisdictions" j
CROSS JOIN (VALUES
  ('World Food Programme', 'WFP', 'world-food-programme', 'multilateral'),
  ('UN Development Programme', 'UNDP', 'un-development-programme', 'multilateral'),
  ('UN High Commissioner for Refugees', 'UNHCR', 'un-high-commissioner-for-refugees', 'multilateral'),
  ('UNICEF', 'UNICEF', 'unicef', 'multilateral'),
  ('World Health Organization', 'WHO', 'world-health-organization', 'multilateral'),
  ('Food and Agriculture Organization', 'FAO', 'food-and-agriculture-organization', 'multilateral'),
  ('UN Population Fund', 'UNFPA', 'un-population-fund', 'multilateral'),
  ('International Atomic Energy Agency', 'IAEA', 'international-atomic-energy-agency', 'multilateral'),
  ('UN Office for Project Services', 'UNOPS', 'un-office-for-project-services', 'multilateral')
) AS agency(name, short_name, slug, type)
WHERE j.slug = 'un'
ON CONFLICT (jurisdiction_id, slug) DO NOTHING;
