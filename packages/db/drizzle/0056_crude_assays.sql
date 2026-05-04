-- Crude assay data ingested from producer-published reports
-- (ExxonMobil unbranded, BP, Equinor, TotalEnergies in this round;
-- Qarat PDF deferred to a follow-up).
--
-- Two tables:
--   1. crude_assays — header per (source, reference). Whole-crude
--      scalar properties + provenance + linkage to crude_grades.slug
--      when the assay clearly maps to a known marker (Brent, Bonny
--      Light, Es Sider, etc).
--   2. crude_assay_cuts — TBP-cut yields + per-cut properties.
--      One row per cut, ordered light → heavy.
--
-- Why a separate table from crude_grades:
--   - crude_grades is curated reference data (one row per marker /
--     trade grade, hand-edited via PR).
--   - crude_assays is producer evidence — multiple rows per grade
--     possible (different producers' assays of "Brent Blend" all
--     belong here, each with their own TBP cut breakdown).
--
-- Idempotency: ingest writes ON CONFLICT (source, reference) DO UPDATE
-- so re-running the script after a producer publishes a new vintage
-- replaces the row in place. Cuts cascade-delete on assay deletion.

CREATE TABLE IF NOT EXISTS crude_assays (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Provenance
  source text NOT NULL,
  -- Producer's reference ID. Examples:
  --   ExxonMobil:    BAKN523Y, BONGA25Y
  --   Equinor:       EKOFISK201506, AASGARD201608
  --   BP:            MM22BTB1
  --   TotalEnergies: BRENT (filename, when no internal ref published)
  reference text NOT NULL,
  -- Original filename (for traceability + re-ingest).
  source_file text,

  -- Identity
  -- Display name from the assay ("Bonga", "Brent Blend",
  -- "EKOFISK 2015 06"). May include vintage suffix.
  name text NOT NULL,
  -- Best-effort link to crude_grades.slug. NULL when no obvious
  -- match — the assay still lands and a follow-up can link it.
  grade_slug text,

  -- Origin
  -- ISO-2 country code. NULL when origin not parseable.
  origin_country text,
  -- Free-text origin label as published ("Nigeria", "North Sea -
  -- UK", "PADD3 Gulf"). Useful when origin spans multiple ISO-2.
  origin_label text,

  -- Dates (parsed from the assay sheet; nullable when absent)
  sample_date date,
  assay_date date,
  issue_date date,

  -- Whole-crude scalar properties. All nullable; not every
  -- producer publishes every field.
  density_kg_l numeric,
  api_gravity numeric,
  bbl_per_mt numeric,
  sulphur_wt_pct numeric,
  pour_point_c numeric,
  -- Total acid number (TAN), mg KOH/g.
  acidity_mg_koh_g numeric,
  vanadium_mg_kg numeric,
  nickel_mg_kg numeric,
  nitrogen_mg_kg numeric,
  rvp_kpa numeric,
  viscosity_cst_20c numeric,
  viscosity_cst_50c numeric,
  mercaptan_sulphur_mg_kg numeric,
  h2s_mg_kg numeric,
  wax_appearance_temp_c numeric,

  comments text,
  -- Full parsed summary block as a key/value map — preserves any
  -- field we don't model as a column (paraffin %, NaCl, etc.) so
  -- a follow-up can mine it without re-parsing the source files.
  raw jsonb,

  created_at timestamp with time zone NOT NULL DEFAULT NOW(),
  updated_at timestamp with time zone NOT NULL DEFAULT NOW()
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS crude_assays_source_ref_uniq
  ON crude_assays (source, reference);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS crude_assays_name_idx
  ON crude_assays (lower(name));
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS crude_assays_grade_idx
  ON crude_assays (grade_slug)
  WHERE grade_slug IS NOT NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS crude_assays_country_idx
  ON crude_assays (origin_country)
  WHERE origin_country IS NOT NULL;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS crude_assay_cuts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  assay_id uuid NOT NULL REFERENCES crude_assays(id) ON DELETE CASCADE,

  -- Cut label as the producer published it. Free text — varies
  -- per source ("Light Naphtha", "Heavy Naphtha", "Kerosene",
  -- "Atmospheric Gasoil", "Vacuum Residue", etc.). Producers
  -- don't agree on a fixed taxonomy.
  cut_label text NOT NULL,
  -- Order within the assay, light → heavy (0-indexed).
  cut_order integer NOT NULL,

  -- Cut temperature window (°C). NULL for whole-crude rows or
  -- when source omits.
  start_temp_c numeric,
  end_temp_c numeric,

  -- Yields. NULL when not published.
  yield_wt_pct numeric,
  yield_vol_pct numeric,
  cumulative_yield_wt_pct numeric,

  -- Per-cut properties. NULL when not published.
  density_kg_l numeric,
  sulphur_wt_pct numeric,

  -- Raw cell map for fields we don't model (mercaptan per cut,
  -- viscosity per cut, smoke point, freeze point, etc.).
  raw jsonb,

  created_at timestamp with time zone NOT NULL DEFAULT NOW()
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS crude_assay_cuts_assay_idx
  ON crude_assay_cuts (assay_id);
