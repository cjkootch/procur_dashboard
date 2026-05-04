import {
  pgTable,
  uuid,
  text,
  numeric,
  timestamp,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';
import { vessels } from './vessels';
import { ports } from './ports';

/**
 * Cargo trips — pair-wise inferences of (load port → discharge
 * port) voyages, derived from `vessel_positions` clustering at
 * port geofences.
 *
 * Distinct from `vessel_positions` (raw AIS reports) and
 * `findRecentPortCalls` (single-port slow-speed clusters): this
 * table captures the *paired* port-call sequence — a single
 * voyage that loaded somewhere and discharged somewhere else.
 *
 * Inference job: services/scrapers/cargo-trip-inference.ts
 * (or wherever the runner lands; ingest is in the catalog package
 * for now). Algorithm + caveats in migration 0060's header.
 *
 * Public-domain. Shared across tenants. No companyId scoping.
 */
export const cargoTrips = pgTable(
  'cargo_trips',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /** Vessel that performed the trip. */
    mmsi: text('mmsi')
      .notNull()
      .references(() => vessels.mmsi, { onDelete: 'cascade' }),

    /** Loading port-call. */
    loadPortSlug: text('load_port_slug')
      .notNull()
      .references(() => ports.slug),
    loadStartedAt: timestamp('load_started_at', { withTimezone: true }).notNull(),
    loadCompletedAt: timestamp('load_completed_at', { withTimezone: true }).notNull(),

    /** Discharge port-call. */
    dischargePortSlug: text('discharge_port_slug')
      .notNull()
      .references(() => ports.slug),
    dischargeStartedAt: timestamp('discharge_started_at', { withTimezone: true }).notNull(),
    dischargeCompletedAt: timestamp('discharge_completed_at', { withTimezone: true }).notNull(),

    /** Inferred grade from load_port.known_grades. NULL when the
     *  loading port reports multiple grades (ambiguous) or none. */
    inferredGradeSlug: text('inferred_grade_slug'),

    /** Volume estimate in barrels — DWT × ~0.95 fill × bbl/MT. NULL
     *  when DWT missing or the conversion is too uncertain. ±15%
     *  typical error; useful directionally, not absolutely. */
    inferredVolumeBbl: numeric('inferred_volume_bbl', { precision: 14, scale: 2 }),

    /** 0.0-1.0 confidence in the trip pairing. See migration 0060
     *  header for the heuristic. */
    confidence: numeric('confidence', { precision: 3, scale: 2 }).notNull(),

    voyageNm: numeric('voyage_nm', { precision: 10, scale: 1 }),
    voyageHours: numeric('voyage_hours', { precision: 10, scale: 1 }),

    inferredAt: timestamp('inferred_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    replayIdx: uniqueIndex('cargo_trips_replay_idx').on(
      table.mmsi,
      table.loadPortSlug,
      table.loadStartedAt,
    ),
    mmsiIdx: index('cargo_trips_mmsi_idx').on(table.mmsi, table.loadStartedAt),
    loadPortIdx: index('cargo_trips_load_port_idx').on(
      table.loadPortSlug,
      table.loadStartedAt,
    ),
    dischargePortIdx: index('cargo_trips_discharge_port_idx').on(
      table.dischargePortSlug,
      table.dischargeStartedAt,
    ),
    gradeIdx: index('cargo_trips_grade_idx').on(table.inferredGradeSlug),
  }),
);

export type CargoTrip = typeof cargoTrips.$inferSelect;
export type NewCargoTrip = typeof cargoTrips.$inferInsert;
