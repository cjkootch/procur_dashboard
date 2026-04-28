CREATE TABLE IF NOT EXISTS "known_entities" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "slug" text NOT NULL UNIQUE,
  "name" text NOT NULL,
  "country" text NOT NULL,
  "role" text NOT NULL,
  "categories" text[] NOT NULL,
  "notes" text,
  "contact_entity" text,
  "aliases" text[],
  "tags" text[],
  "metadata" jsonb,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "known_entities_country_idx" ON "known_entities" ("country");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "known_entities_role_idx" ON "known_entities" ("role");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "known_entities_categories_idx" ON "known_entities" USING gin ("categories");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "known_entities_tags_idx" ON "known_entities" USING gin ("tags");
