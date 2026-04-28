-- VTC commodity categories: food, fuel, minerals. `vehicles-fleet` already
-- exists in the seed taxonomy. These categories are top-level (no
-- parent_slug) so the Discover filter UI surfaces them — the existing
-- sidebar logic shows only categories with `parent_slug IS NULL`.
--
-- The SAM and CanadaBuys scrapers tag opportunities with these slugs at
-- scrape time so users can filter to "food/fuel/vehicles/minerals" rows
-- without scanning the full catalog. Idempotent — `ON CONFLICT DO
-- NOTHING` makes this safe to re-run.

INSERT INTO "taxonomy_categories" ("slug", "name", "sort_order", "active")
VALUES
  ('food-commodities', 'Food Commodities', 111, true),
  ('petroleum-fuels', 'Petroleum and Fuels', 41, true),
  ('minerals-metals', 'Minerals and Metals', 220, true)
ON CONFLICT (slug) DO NOTHING;
