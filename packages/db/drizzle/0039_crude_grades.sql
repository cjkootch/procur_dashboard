CREATE TABLE IF NOT EXISTS "crude_grades" (
  "slug" text PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "origin_country" text,
  "region" text,
  "api_gravity" numeric,
  "sulfur_pct" numeric,
  "tan" numeric,
  "characterization" text,
  "is_marker" boolean DEFAULT false NOT NULL,
  "loading_country" text,
  "notes" text,
  "source" text,
  "metadata" jsonb,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "crude_grades_origin_country_idx" ON "crude_grades" ("origin_country");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "crude_grades_region_idx" ON "crude_grades" ("region");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "crude_grades_marker_idx" ON "crude_grades" ("is_marker");
