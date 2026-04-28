import {
  pgTable,
  bigserial,
  text,
  numeric,
  timestamp,
  index,
} from 'drizzle-orm/pg-core';

/**
 * Time-series of AIS position reports. One row per (mmsi, timestamp).
 *
 * Volume warning: high-frequency tankers broadcast every ~30s while
 * underway. Even with a Mediterranean-only bbox + tanker filter,
 * expect ~50-200 inserts/min during active hours. Partition by month
 * once this exceeds ~50M rows; for v1 a single table with a
 * (mmsi, timestamp DESC) index is enough.
 *
 * No FK to vessels.mmsi — the constraint cost on a hot-write table
 * isn't worth it; orphaned positions are tolerated and the
 * `ingest-aisstream` worker upserts vessels + positions in lockstep.
 *
 * Public-domain. No companyId.
 */
export const vesselPositions = pgTable(
  'vessel_positions',
  {
    /** Bigserial because high write volume. */
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    mmsi: text('mmsi').notNull(),
    /** WGS84 decimal degrees. */
    lat: numeric('lat').notNull(),
    lng: numeric('lng').notNull(),
    /** Speed over ground, knots. NULL if not broadcast. */
    speedKnots: numeric('speed_knots'),
    /** Course over ground, degrees true. */
    course: numeric('course'),
    /** AIS navigational status: 'underway' | 'at-anchor' | 'moored' |
        'aground' | 'fishing' | 'other'. Free-text — we normalize at
        ingest. */
    navStatus: text('nav_status'),
    /** When the position was reported (NOT when it was ingested). */
    timestamp: timestamp('timestamp').notNull(),
  },
  (table) => ({
    mmsiTimeIdx: index('vessel_positions_mmsi_time_idx').on(
      table.mmsi,
      table.timestamp,
    ),
    timeIdx: index('vessel_positions_time_idx').on(table.timestamp),
  }),
);

export type VesselPosition = typeof vesselPositions.$inferSelect;
export type NewVesselPosition = typeof vesselPositions.$inferInsert;
