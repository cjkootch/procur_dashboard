-- Fuel consumption signals — derived/declared annual fuel volume
-- estimates per entity, sourced from external data we can convert
-- into bbl/yr ranges. Each row is one signal from one source; an
-- entity can have multiple rows from different sources, weighted
-- by confidence at query time.
--
-- Spec: research thread on "data sources for fuel consumption by
-- business/industry" — first source populated is mining production
-- × industry-standard diesel intensity (per the bauxite case in
-- docs/caribbean-fuel-buyer-brief.md §1).
--
-- The entity_slug column is text rather than a hard FK because we
-- support both known_entities.slug and external_suppliers.id (UUID)
-- as canonical keys — same shape getEntityProfile uses.

CREATE TABLE IF NOT EXISTS fuel_consumption_signals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_slug text NOT NULL,

  /** Where this signal came from. One of:
      'cdp' | 'gri' | 'mining_production' | 'power_capacity'
      | 'port_bunkers' | 'subsidy_allocation' | 'ais_inferred'
      | 'analyst_estimate'. New values added by application code
      without migration. */
  source text NOT NULL,

  /** Annual fuel volume range in barrels. min == max when the
      source gives a point estimate; both NULL when the signal is
      only qualitative. */
  volume_bbl_yr_min numeric(20, 2),
  volume_bbl_yr_max numeric(20, 2),

  /** 0-1 confidence in the volume estimate. 1.0 = published by
      the entity itself (CDP / 10-K). 0.7 = derived from
      operational data + standard intensity. 0.4 = analyst guess
      without published anchor. */
  confidence numeric(3, 2),

  /** Period the signal applies to. as_of_date is when we observed
      the underlying data; coverage_year is the calendar year the
      volume estimate represents. */
  as_of_date date NOT NULL DEFAULT CURRENT_DATE,
  coverage_year integer,

  /** Free-text notes — methodology / caveats / unit conversions
      the analyst applied. Markdown-friendly. */
  notes text,

  /** Provenance URL. CDP filing link, USGS publication PDF, port
      authority page, etc. */
  source_url text,

  /** Source-specific raw data — the underlying scale figure +
      intensity factor used, the CDP scope-1-tCO2 value and the
      conversion factor, the mine's tonnes-of-ore + the L/t rate.
      Lets us re-run the calc when intensity factors update. */
  raw_data jsonb,

  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS fuel_consumption_signals_entity_idx
  ON fuel_consumption_signals (entity_slug);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS fuel_consumption_signals_source_idx
  ON fuel_consumption_signals (source);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS fuel_consumption_signals_coverage_year_idx
  ON fuel_consumption_signals (coverage_year);
--> statement-breakpoint

-- Industry diesel-intensity factors. Static reference table —
-- analyst-curated coefficients for converting operational scale
-- (tonnes ore, MW capacity, hectares, etc.) into bbl/yr fuel
-- estimates. Updated when industry-standard rates shift.
CREATE TABLE IF NOT EXISTS fuel_intensity_factors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  /** Industry / activity slug — 'mining-bauxite-extraction',
      'power-gen-diesel-peaker', 'aviation-fuel-uplift', etc.
      Stable kebab-case identifier; referenced from raw_data on
      consumption signals. */
  slug text NOT NULL UNIQUE,
  /** Human-readable label. */
  name text NOT NULL,
  /** What scale unit converts to fuel via this factor —
      'tonnes_ore' | 'mwh_generated' | 'flight_hours'
      | 'hectares_planted' | 'occupied_room_nights'. */
  scale_unit text NOT NULL,
  /** Liters of diesel-equivalent per scale unit. Mid-range
      estimate; min/max provide the band when industry coverage
      is wide (e.g. open-pit vs underground mining). */
  liters_per_unit numeric(14, 4) NOT NULL,
  liters_per_unit_min numeric(14, 4),
  liters_per_unit_max numeric(14, 4),
  /** Source for the factor — IEA, EIA, IFC, ICMM, etc. */
  source text,
  source_url text,
  notes text,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS fuel_intensity_factors_slug_idx
  ON fuel_intensity_factors (slug);
