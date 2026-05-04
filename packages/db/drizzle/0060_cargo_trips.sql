-- Cargo trips — pair-wise inferences of (load port → discharge port)
-- voyages, derived from `vessel_positions` clustering at port
-- geofences.
--
-- Brief: docs/data-graph-connections-brief.md §5 (work item 4).
--
-- Algorithm (run by services/scrapers/cargo-trip-inference.ts):
--   1. For each tanker (vessels.shipTypeLabel like '%tanker%'),
--      pull the last 90 days of vessel_positions ordered by ts.
--   2. Identify "in-port" intervals — runs of positions inside any
--      port's geofence radius with speedKnots < 2 for >= 2 hours.
--      Same shape findRecentPortCalls already uses.
--   3. Pair each consecutive (in-port, in-port) sequence into a
--      trip: load = first interval, discharge = next interval.
--      Skip pairs at the same port (loitering / inland barge);
--      skip pairs with > 60-day gap (likely missed AIS coverage).
--   4. Look up loadPort.known_grades. If exactly one grade, set
--      inferred_grade_slug. If multiple, leave NULL (ambiguous).
--   5. Estimate volume: vessels.dwt * 0.95 fill * density-adjusted
--      bbl/MT. NULL when DWT missing.
--   6. Confidence (0-1):
--      - 1.0 baseline
--      - -0.3 if multiple grades at load port
--      - -0.2 if voyage_hours implies an off-pace average speed
--      - -0.1 per intermediate position outside any port geofence
--        > 5 days during the voyage (suggests STS or detour)
--
-- Idempotent on (mmsi, load_port_slug, load_started_at) — re-running
-- the job over an overlapping window upserts in place.
--
-- Coverage caveat: limited to AIS bounding boxes the procur ingest
-- subscribes to (Med / Caribbean / US Gulf / WAF). Trips entirely
-- outside the boxes are invisible — the table is "what we can see,"
-- not "everything that happened."

CREATE TABLE IF NOT EXISTS cargo_trips (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Vessel that performed the trip. FK to vessels.mmsi.
  mmsi text NOT NULL REFERENCES vessels(mmsi) ON DELETE CASCADE,

  -- Loading port-call.
  load_port_slug text NOT NULL REFERENCES ports(slug),
  load_started_at timestamp with time zone NOT NULL,
  load_completed_at timestamp with time zone NOT NULL,

  -- Discharge port-call.
  discharge_port_slug text NOT NULL REFERENCES ports(slug),
  discharge_started_at timestamp with time zone NOT NULL,
  discharge_completed_at timestamp with time zone NOT NULL,

  -- Inferred grade from load_port.known_grades. NULL when the
  -- loading port reports multiple grades (ambiguous) or none.
  inferred_grade_slug text,

  -- Volume estimate in barrels. Computed from vessels.dwt × fill
  -- factor × bbl/MT. NULL when DWT is missing or the conversion
  -- is too uncertain.
  inferred_volume_bbl numeric(14, 2),

  -- 0.0-1.0 confidence in the trip pairing. See header comment for
  -- the heuristic deductions.
  confidence numeric(3, 2) NOT NULL,

  voyage_nm numeric(10, 1),
  voyage_hours numeric(10, 1),

  inferred_at timestamp with time zone NOT NULL DEFAULT NOW(),
  updated_at timestamp with time zone NOT NULL DEFAULT NOW()
);
--> statement-breakpoint

-- Idempotency / re-run key. The trip is uniquely identified by
-- (vessel, where it loaded, when it started loading).
CREATE UNIQUE INDEX IF NOT EXISTS cargo_trips_replay_idx
  ON cargo_trips (mmsi, load_port_slug, load_started_at);
--> statement-breakpoint

-- "Trips by this vessel" lookup.
CREATE INDEX IF NOT EXISTS cargo_trips_mmsi_idx
  ON cargo_trips (mmsi, load_started_at DESC);
--> statement-breakpoint

-- "Trips loading at this port" — for producing-country marketing
-- arms / loading terminals.
CREATE INDEX IF NOT EXISTS cargo_trips_load_port_idx
  ON cargo_trips (load_port_slug, load_started_at DESC);
--> statement-breakpoint

-- "Trips discharging at this port" — for refineries / consuming
-- terminals.
CREATE INDEX IF NOT EXISTS cargo_trips_discharge_port_idx
  ON cargo_trips (discharge_port_slug, discharge_started_at DESC);
--> statement-breakpoint

-- "Trips by grade" — when grade was inferred.
CREATE INDEX IF NOT EXISTS cargo_trips_grade_idx
  ON cargo_trips (inferred_grade_slug)
  WHERE inferred_grade_slug IS NOT NULL;
