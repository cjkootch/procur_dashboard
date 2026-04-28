-- Schema cleanup pass after the external review. Three independent
-- fixes bundled because each is small and they share a migration:
--   (1) content_library.previous_version_id: add a self-FK so version-
--       history pointers can't dangle. ON DELETE SET NULL keeps a row
--       alive when its predecessor is deleted.
--   (2) taxonomy_categories.parent_slug: add an FK referencing slug
--       (which is already UNIQUE). Same referential integrity as a
--       parent_id rename without breaking the 5+ readers that already
--       use parent_slug across Discover, AI tasks, and seed-data.
--   (3) alert_profiles.min_value / max_value: standardize to
--       numeric(20, 2) — every other money column in the schema uses
--       that precision; default-precision numeric() trips reviewers
--       and is easy to miss when grepping for monetary fields.

ALTER TABLE "content_library"
  ADD CONSTRAINT "content_library_previous_version_id_fkey"
  FOREIGN KEY ("previous_version_id")
  REFERENCES "content_library" ("id")
  ON DELETE SET NULL;
--> statement-breakpoint

ALTER TABLE "taxonomy_categories"
  ADD CONSTRAINT "taxonomy_categories_parent_slug_fkey"
  FOREIGN KEY ("parent_slug")
  REFERENCES "taxonomy_categories" ("slug")
  ON DELETE SET NULL;
--> statement-breakpoint

-- ALTER TYPE on numeric requires USING for an explicit cast even
-- though numeric→numeric is implicit; Postgres still rejects without it
-- when precision/scale changes. The CAST is a no-op for valid existing
-- values; rows with values exceeding 20 digits would fail loudly here
-- (none expected — alert-profile thresholds are user-entered budgets).
ALTER TABLE "alert_profiles"
  ALTER COLUMN "min_value" TYPE numeric(20, 2) USING "min_value"::numeric(20, 2);
--> statement-breakpoint

ALTER TABLE "alert_profiles"
  ALTER COLUMN "max_value" TYPE numeric(20, 2) USING "max_value"::numeric(20, 2);
