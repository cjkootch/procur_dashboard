/**
 * Cargo-trip inference — pair consecutive port calls per tanker
 * into (load → discharge) trip records.
 *
 * Input: vessel_positions (raw AIS), vessels (registry), ports
 * (geofences + known_grades).
 *
 * Output: cargo_trips rows, one per inferred trip. See migration
 * 0060's header for the algorithm + caveats.
 *
 * Idempotency: ON CONFLICT (mmsi, load_port_slug, load_started_at)
 * DO UPDATE — re-running over an overlapping window upserts
 * recently-inferred trips in place rather than duplicating them.
 *
 * Run:
 *   pnpm --filter @procur/db infer-cargo-trips
 *   pnpm --filter @procur/db infer-cargo-trips --days=90 --dry-run
 *   pnpm --filter @procur/db infer-cargo-trips --mmsi=311000123
 *
 * Performance note: this is a SQL-heavy job (clusters AIS positions
 * across N tankers × W days × M ports). Single-statement CTE
 * approach below works for the current AIS volume (~50k positions/
 * day across the subscribed bounding boxes); revisit if coverage
 * expands beyond ~2x current scale.
 */
import 'dotenv/config';
import { config as loadEnv } from 'dotenv';
import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import { sql } from 'drizzle-orm';

import * as schema from './schema';

loadEnv({ path: '../../.env.local' });
loadEnv({ path: '../../.env' });

export type InferCargoTripsResult = {
  windowDays: number;
  inferredTrips: number;
  perVessel: Array<{ mmsi: string; trips: number }>;
};

/**
 * Build the CTE chain that produces (mmsi, load*, discharge*,
 * inferred_grade_slug, inferred_volume_bbl, confidence, voyage_*)
 * rows. Used by both the dry-run SELECT path and the production
 * INSERT path.
 *
 * Algorithm:
 *   1. tankers — vessels with shipTypeLabel containing "tanker".
 *   2. matches — slow-speed (<2 kt) AIS positions inside any port's
 *      geofence within the lookback window.
 *   3. calls — gap-detect contiguous runs of matches per
 *      (mmsi, port) into "calls" (sessions where the gap between
 *      consecutive AIS reports stays under 24h). Filter to calls
 *      with >= 2 hour duration.
 *   4. paired — pair each call with the FIRST subsequent call by
 *      the same vessel at a different port within 60 days.
 *   5. enriched — add DWT, port coordinates → voyage distance,
 *      voyage hours.
 *   6. final SELECT — derive inferred_grade_slug from
 *      load_port.known_grades (only when single-grade), volume
 *      from DWT × 0.95 × 7.46 bbl/MT, confidence from a heuristic
 *      that penalises ambiguous-grade ports + off-pace voyages.
 */
function buildInferenceCte(args: { windowDays: number; mmsi?: string }) {
  const { windowDays, mmsi } = args;
  return sql`
    WITH tankers AS (
      SELECT mmsi, dwt
      FROM vessels
      WHERE COALESCE(ship_type_label, '') ILIKE '%tanker%'
        ${mmsi ? sql`AND mmsi = ${mmsi}` : sql``}
    ),
    matches AS (
      SELECT
        vp.mmsi,
        p.slug AS port_slug,
        vp.timestamp
      FROM vessel_positions vp
      JOIN tankers t ON t.mmsi = vp.mmsi
      JOIN ports p
        ON SQRT(
          POW((vp.lat::numeric - p.lat::numeric) * 60, 2) +
          POW(
            (vp.lng::numeric - p.lng::numeric) * 60 *
              COS(RADIANS(p.lat::numeric)),
            2
          )
        ) <= p.geofence_radius_nm::numeric
      WHERE vp.timestamp >= NOW() - (${windowDays}::int * INTERVAL '1 day')
        AND (vp.speed_knots IS NULL OR vp.speed_knots::numeric < 2)
    ),
    gapped AS (
      SELECT
        mmsi,
        port_slug,
        timestamp,
        timestamp - LAG(timestamp) OVER (
          PARTITION BY mmsi, port_slug ORDER BY timestamp
        ) AS gap
      FROM matches
    ),
    sessioned AS (
      SELECT
        mmsi,
        port_slug,
        timestamp,
        SUM(CASE WHEN gap > INTERVAL '24 hours' THEN 1 ELSE 0 END)
          OVER (PARTITION BY mmsi, port_slug ORDER BY timestamp) AS session_id
      FROM gapped
    ),
    calls AS (
      SELECT
        mmsi,
        port_slug,
        MIN(timestamp) AS started_at,
        MAX(timestamp) AS completed_at
      FROM sessioned
      GROUP BY mmsi, port_slug, session_id
      HAVING MAX(timestamp) - MIN(timestamp) >= INTERVAL '2 hours'
    ),
    candidate_trips AS (
      SELECT
        c1.mmsi,
        c1.port_slug AS load_port_slug,
        c1.started_at AS load_started_at,
        c1.completed_at AS load_completed_at,
        c2.port_slug AS discharge_port_slug,
        c2.started_at AS discharge_started_at,
        c2.completed_at AS discharge_completed_at,
        ROW_NUMBER() OVER (
          PARTITION BY c1.mmsi, c1.port_slug, c1.started_at
          ORDER BY c2.started_at
        ) AS rn
      FROM calls c1
      JOIN calls c2
        ON c2.mmsi = c1.mmsi
       AND c2.port_slug <> c1.port_slug
       AND c2.started_at > c1.completed_at
       AND c2.started_at <= c1.completed_at + INTERVAL '60 days'
    ),
    enriched AS (
      SELECT
        ct.mmsi,
        ct.load_port_slug,
        ct.load_started_at,
        ct.load_completed_at,
        ct.discharge_port_slug,
        ct.discharge_started_at,
        ct.discharge_completed_at,
        v.dwt::numeric AS dwt,
        lp.known_grades AS load_known_grades,
        SQRT(
          POW((lp.lat::numeric - dp.lat::numeric) * 60, 2) +
          POW(
            (lp.lng::numeric - dp.lng::numeric) * 60 *
              COS(RADIANS(lp.lat::numeric)),
            2
          )
        ) AS voyage_nm,
        EXTRACT(
          EPOCH FROM (ct.discharge_started_at - ct.load_completed_at)
        ) / 3600.0 AS voyage_hours
      FROM candidate_trips ct
      JOIN vessels v ON v.mmsi = ct.mmsi
      JOIN ports lp ON lp.slug = ct.load_port_slug
      JOIN ports dp ON dp.slug = ct.discharge_port_slug
      WHERE ct.rn = 1
    )
    SELECT
      mmsi,
      load_port_slug,
      load_started_at,
      load_completed_at,
      discharge_port_slug,
      discharge_started_at,
      discharge_completed_at,
      CASE
        WHEN load_known_grades IS NOT NULL
          AND array_length(load_known_grades, 1) = 1
        THEN load_known_grades[1]
        ELSE NULL
      END AS inferred_grade_slug,
      CASE
        WHEN dwt IS NOT NULL AND dwt > 0
        THEN ROUND(dwt * 0.95 * 7.46, 2)
        ELSE NULL
      END AS inferred_volume_bbl,
      ROUND(
        GREATEST(
          0.0,
          (CASE
            WHEN load_known_grades IS NOT NULL
              AND array_length(load_known_grades, 1) > 1
            THEN 0.7
            ELSE 1.0
          END)
          - (CASE
            WHEN voyage_hours > 0
              AND voyage_nm > 0
              AND (voyage_nm / voyage_hours) NOT BETWEEN 8 AND 18
            THEN 0.2
            ELSE 0.0
          END)
        ),
        2
      ) AS confidence,
      ROUND(voyage_nm::numeric, 1) AS voyage_nm,
      ROUND(voyage_hours::numeric, 1) AS voyage_hours
    FROM enriched
  `;
}

export async function inferCargoTrips(opts: {
  windowDays?: number;
  mmsi?: string;
  dryRun?: boolean;
}): Promise<InferCargoTripsResult> {
  const windowDays = opts.windowDays ?? 90;
  const dryRun = opts.dryRun ?? false;

  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error('DATABASE_URL not set');
  const db = drizzle(neon(dbUrl), { schema });

  const cte = buildInferenceCte({ windowDays, mmsi: opts.mmsi });

  if (dryRun) {
    const result = await db.execute(cte);
    const rows = result.rows as Array<{ mmsi: unknown }>;
    return {
      windowDays,
      inferredTrips: rows.length,
      perVessel: aggregatePerVessel(rows),
    };
  }

  const result = await db.execute(sql`
    INSERT INTO cargo_trips (
      mmsi, load_port_slug, load_started_at, load_completed_at,
      discharge_port_slug, discharge_started_at, discharge_completed_at,
      inferred_grade_slug, inferred_volume_bbl, confidence,
      voyage_nm, voyage_hours, updated_at
    )
    SELECT
      mmsi, load_port_slug, load_started_at, load_completed_at,
      discharge_port_slug, discharge_started_at, discharge_completed_at,
      inferred_grade_slug, inferred_volume_bbl, confidence,
      voyage_nm, voyage_hours, NOW()
    FROM ( ${cte} ) AS picked
    ON CONFLICT (mmsi, load_port_slug, load_started_at) DO UPDATE
    SET
      load_completed_at      = EXCLUDED.load_completed_at,
      discharge_port_slug    = EXCLUDED.discharge_port_slug,
      discharge_started_at   = EXCLUDED.discharge_started_at,
      discharge_completed_at = EXCLUDED.discharge_completed_at,
      inferred_grade_slug    = EXCLUDED.inferred_grade_slug,
      inferred_volume_bbl    = EXCLUDED.inferred_volume_bbl,
      confidence             = EXCLUDED.confidence,
      voyage_nm              = EXCLUDED.voyage_nm,
      voyage_hours           = EXCLUDED.voyage_hours,
      updated_at             = NOW()
    RETURNING mmsi;
  `);
  const upsertedRows = result.rows as Array<{ mmsi: unknown }>;

  return {
    windowDays,
    inferredTrips: upsertedRows.length,
    perVessel: aggregatePerVessel(upsertedRows),
  };
}

function aggregatePerVessel(
  rows: Array<{ mmsi: unknown }>,
): Array<{ mmsi: string; trips: number }> {
  const counts = new Map<string, number>();
  for (const r of rows) {
    const m = String(r.mmsi);
    counts.set(m, (counts.get(m) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([mmsi, trips]) => ({ mmsi, trips }))
    .sort((a, b) => b.trips - a.trips);
}

async function main() {
  const args = process.argv.slice(2);
  const daysArg = args.find((a) => a.startsWith('--days='))?.split('=')[1];
  const mmsiArg = args.find((a) => a.startsWith('--mmsi='))?.split('=')[1];
  const dryRun = args.includes('--dry-run');
  const r = await inferCargoTrips({
    windowDays: daysArg ? Number.parseInt(daysArg, 10) : undefined,
    mmsi: mmsiArg,
    dryRun,
  });
  console.log(
    `Inferred ${r.inferredTrips} trips${dryRun ? ' (dry-run)' : ''} across ${r.perVessel.length} vessels over ${r.windowDays} days.`,
  );
  for (const v of r.perVessel.slice(0, 10)) {
    console.log(`  ${v.mmsi}: ${v.trips} trips`);
  }
}

if (process.argv[1] && process.argv[1].endsWith('infer-cargo-trips.ts')) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
