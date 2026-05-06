-- Per-facility geospatial / time-series activity observations.
-- Foundation for VIIRS Nighttime Lights (brief §4.4) and any other
-- proxy-style activity signal that fits the (entity, source, date,
-- value) shape (e.g. AIS port-call days, MODIS thermal anomalies,
-- Sentinel SAR equipment-movement counts).
--
-- Distinct from fuel_consumption_signals because:
--   - Granularity is per-observation (typically monthly), not annual
--   - Value units are source-specific (nW/cm²/sr for VIIRS, etc.) —
--     not bbl/yr
--   - Time-series analysis happens in the application layer; this
--     table just stores the raw readings
--
-- The yearly aggregation step (turn 12 monthly readings into one
-- fuel_consumption_signals row at signal_kind='activity_signal') is
-- a follow-up — for now this table is the foundation that lets the
-- VIIRS ingest land observations safely without committing to a
-- specific aggregation methodology yet.

CREATE TABLE IF NOT EXISTS entity_activity_observations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  /** Same canonical-key shape getEntityProfile + fuel_consumption_signals
      use — accepts known_entities.slug or external_suppliers.id (UUID).
      Joins back to either at query time. */
  entity_slug text NOT NULL,

  /** Source of the observation. New values added by application code
      without migration:
        'viirs_ntl'        — VIIRS DNB Nighttime Lights monthly composite
        'modis_thermal'    — MODIS FIRMS thermal anomaly
        'sentinel1_sar'    — Sentinel-1 SAR equipment-movement counts
        'sentinel2_optical'— Sentinel-2 optical activity proxy
        'ais_port_calls'   — derived AIS port-call days (already in
                             vessel_positions but rolled up here as
                             a per-facility activity series)
      Free text. */
  source text NOT NULL,

  /** Date the observation applies to. Conventionally month-start
      for monthly composites (e.g. 2024-03-01 for the March 2024
      VIIRS composite). */
  observation_date date NOT NULL,

  /** The observation value. Numeric range varies wildly by source —
      VIIRS NTL is ~0-300 nW/cm²/sr at industrial facility scale;
      thermal anomalies are 0-1 fire-detection probability; etc.
      Always paired with `unit` for interpretation. */
  value numeric(20, 6) NOT NULL,

  /** Unit of the value. e.g. 'nW/cm2/sr' for VIIRS, 'fire_count'
      for thermal anomalies, 'port_call_days' for AIS-derived. */
  unit text NOT NULL,

  notes text,

  /** Source-specific provenance — granule ID, processing version,
      lat/long pixel sample, etc. Audit trail. */
  raw_data jsonb,

  created_at timestamp NOT NULL DEFAULT now(),

  /** One row per (entity, source, date) — re-running ingestion on
      the same composite upserts in place. */
  UNIQUE (entity_slug, source, observation_date)
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS entity_activity_observations_slug_idx
  ON entity_activity_observations (entity_slug);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS entity_activity_observations_source_date_idx
  ON entity_activity_observations (source, observation_date);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS entity_activity_observations_date_idx
  ON entity_activity_observations (observation_date);
