ALTER TABLE "known_entities" ADD COLUMN IF NOT EXISTS "latitude" numeric(9, 6);
--> statement-breakpoint
ALTER TABLE "known_entities" ADD COLUMN IF NOT EXISTS "longitude" numeric(9, 6);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "known_entities_geo_idx"
  ON "known_entities" ("latitude", "longitude")
  WHERE "latitude" IS NOT NULL AND "longitude" IS NOT NULL;
