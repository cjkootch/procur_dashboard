import {
  pgTable,
  text,
  integer,
  numeric,
  timestamp,
  jsonb,
  index,
} from 'drizzle-orm/pg-core';

/**
 * Vessel registry — one row per unique MMSI we've seen on AIS. A
 * vessel's identifying triple is (MMSI, IMO, name): MMSI can be
 * reassigned over time when a ship is sold + reflagged, IMO is more
 * permanent but not always broadcast, and name is the human label.
 *
 * Populated by `ingest-aisstream` from the AISStream.io WebSocket feed.
 * Re-runs upsert on `mmsi` so a tanker that changes flag/name shows
 * its latest values without losing identity.
 *
 * Public-domain (AIS broadcasts are uncopyrightable). No companyId.
 */
export const vessels = pgTable(
  'vessels',
  {
    /** Maritime Mobile Service Identity. 9-digit identifier broadcast
        in every AIS message. Primary key — although MMSIs can be
        reassigned, that's an edge case we accept for v1. */
    mmsi: text('mmsi').primaryKey(),
    /** International Maritime Organization number. 7-digit, permanent
        for the life of the hull. Often null in AIS Class B reports. */
    imo: text('imo'),
    /** Vessel name as broadcast — analyst-readable. */
    name: text('name'),
    /** AIS ship-type code (0-99). 80-89 = tanker. */
    shipTypeCode: integer('ship_type_code'),
    /** Derived label: 'crude-tanker' | 'product-tanker' | 'lng' |
        'lpg' | 'chemical' | 'other'. Tankers (80-89) further
        subdivided where ship_type_code distinguishes. */
    shipTypeLabel: text('ship_type_label'),
    /** Flag-state ISO-2 (derived from MMSI MID prefix). */
    flagCountry: text('flag_country'),
    /** Length overall in meters. */
    lengthM: numeric('length_m'),
    /** Deadweight tonnage if reported in static data. */
    dwt: integer('dwt'),
    /** Most recent position-report timestamp ingested. Updated on
        every position write so we can quickly identify stale tracks. */
    lastSeenAt: timestamp('last_seen_at'),
    /** Source-specific extras: callsign, draught, destination. */
    metadata: jsonb('metadata'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => ({
    imoIdx: index('vessels_imo_idx').on(table.imo),
    typeIdx: index('vessels_type_idx').on(table.shipTypeLabel),
    flagIdx: index('vessels_flag_idx').on(table.flagCountry),
    lastSeenIdx: index('vessels_last_seen_idx').on(table.lastSeenAt),
  }),
);

export type Vessel = typeof vessels.$inferSelect;
export type NewVessel = typeof vessels.$inferInsert;
