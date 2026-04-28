CREATE TABLE IF NOT EXISTS "vessels" (
  "mmsi" text PRIMARY KEY NOT NULL,
  "imo" text,
  "name" text,
  "ship_type_code" integer,
  "ship_type_label" text,
  "flag_country" text,
  "length_m" numeric,
  "dwt" integer,
  "last_seen_at" timestamp,
  "metadata" jsonb,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vessels_imo_idx" ON "vessels" ("imo");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vessels_type_idx" ON "vessels" ("ship_type_label");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vessels_flag_idx" ON "vessels" ("flag_country");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vessels_last_seen_idx" ON "vessels" ("last_seen_at");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "vessel_positions" (
  "id" bigserial PRIMARY KEY NOT NULL,
  "mmsi" text NOT NULL,
  "lat" numeric NOT NULL,
  "lng" numeric NOT NULL,
  "speed_knots" numeric,
  "course" numeric,
  "nav_status" text,
  "timestamp" timestamp NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vessel_positions_mmsi_time_idx"
  ON "vessel_positions" ("mmsi", "timestamp");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vessel_positions_time_idx"
  ON "vessel_positions" ("timestamp");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "ports" (
  "slug" text PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "country" text NOT NULL,
  "lat" numeric NOT NULL,
  "lng" numeric NOT NULL,
  "geofence_radius_nm" numeric DEFAULT '3' NOT NULL,
  "port_type" text NOT NULL,
  "known_grades" text[],
  "linked_entity_slug" text,
  "notes" text,
  "metadata" jsonb,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ports_country_idx" ON "ports" ("country");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ports_type_idx" ON "ports" ("port_type");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ports_linked_entity_idx" ON "ports" ("linked_entity_slug");
