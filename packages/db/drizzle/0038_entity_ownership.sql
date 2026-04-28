CREATE TABLE IF NOT EXISTS "entity_ownership" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "source" text NOT NULL,
  "subject_gem_id" text NOT NULL,
  "subject_name" text NOT NULL,
  "parent_gem_id" text NOT NULL,
  "parent_name" text NOT NULL,
  "share_pct" numeric(5, 2),
  "share_imputed" boolean DEFAULT false NOT NULL,
  "source_urls" text,
  "ingested_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "entity_ownership_source_uniq_idx"
  ON "entity_ownership" ("source", "subject_gem_id", "parent_gem_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "entity_ownership_subject_name_trgm_idx"
  ON "entity_ownership" USING gin ("subject_name" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "entity_ownership_parent_name_trgm_idx"
  ON "entity_ownership" USING gin ("parent_name" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "entity_ownership_subject_gem_idx"
  ON "entity_ownership" ("subject_gem_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "entity_ownership_parent_gem_idx"
  ON "entity_ownership" ("parent_gem_id");
