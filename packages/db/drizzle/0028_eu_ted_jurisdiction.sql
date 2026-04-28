-- Add the EU TED (Tenders Electronic Daily) jurisdiction so the
-- TedScraper has somewhere to upsert opportunities. region='global'
-- since TED covers 27 EU member states + EEA + EU institutions —
-- using a country-specific region wouldn't fit. Idempotent — safe to
-- re-run, and seed-data.ts is the source of truth for fresh DBs.

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
  'European Union',
  'eu-ted',
  'EU',
  'global',
  'TED — Tenders Electronic Daily',
  'https://ted.europa.eu',
  'ted',
  'EUR',
  'en',
  'Europe/Brussels',
  true
)
ON CONFLICT (slug) DO NOTHING;
--> statement-breakpoint

-- Seed common EU institutional buyers + a few national defence/aid
-- agencies that publish heavy on TED. resolveAgencyId in
-- upsertOpportunity creates rows for misses, so this just primes the
-- frequently-recurring ones.
INSERT INTO "agencies" ("jurisdiction_id", "name", "short_name", "slug", "type")
SELECT j.id, agency.name, agency.short_name, agency.slug, agency.type
FROM "jurisdictions" j
CROSS JOIN (VALUES
  ('European Commission', 'EC', 'european-commission', 'multilateral'),
  ('European Defence Agency', 'EDA', 'european-defence-agency', 'multilateral'),
  ('European External Action Service', 'EEAS', 'eeas', 'multilateral'),
  ('European Civil Protection and Humanitarian Aid Operations', 'ECHO', 'echo', 'multilateral'),
  ('NATO Support and Procurement Agency', 'NSPA', 'nspa', 'multilateral'),
  ('North Atlantic Treaty Organisation', 'NATO', 'nato', 'multilateral')
) AS agency(name, short_name, slug, type)
WHERE j.slug = 'eu-ted'
ON CONFLICT (jurisdiction_id, slug) DO NOTHING;
