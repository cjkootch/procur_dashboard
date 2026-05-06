import {
  pgTable,
  uuid,
  text,
  timestamp,
  numeric,
  date,
  jsonb,
  index,
  unique,
} from 'drizzle-orm/pg-core';

/**
 * Per-facility geospatial / time-series activity observations.
 * Foundation for VIIRS Nighttime Lights (buyer-intelligence-v2-
 * free-sources-brief.md §4.4) and any other proxy-style activity
 * signal that fits the (entity, source, date, value) shape.
 *
 * Distinct from fuel_consumption_signals: granularity is per-
 * observation (typically monthly) not annual, units are source-
 * specific (nW/cm²/sr for VIIRS), and time-series analysis happens
 * in application layer.
 *
 * Yearly aggregation into fuel_consumption_signals (signal_kind=
 * 'activity_signal') is a follow-up step — this table is the raw
 * landing zone.
 */
export const entityActivityObservations = pgTable(
  'entity_activity_observations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Same canonical-key shape getEntityProfile + fuel_consumption_signals
        use — accepts known_entities.slug or external_suppliers.id (UUID). */
    entitySlug: text('entity_slug').notNull(),
    /** 'viirs_ntl' | 'modis_thermal' | 'sentinel1_sar' |
        'sentinel2_optical' | 'ais_port_calls' | etc. — free text. */
    source: text('source').notNull(),
    /** Conventionally month-start for monthly composites
        (e.g. 2024-03-01 for the March 2024 VIIRS composite). */
    observationDate: date('observation_date').notNull(),
    value: numeric('value', { precision: 20, scale: 6 }).notNull(),
    /** 'nW/cm2/sr' for VIIRS, 'fire_count' for thermal anomalies,
        'port_call_days' for AIS-derived. */
    unit: text('unit').notNull(),
    notes: text('notes'),
    /** Source-specific provenance — granule ID, processing version,
        lat/long pixel sample, etc. */
    rawData: jsonb('raw_data'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => ({
    slugIdx: index('entity_activity_observations_slug_idx').on(table.entitySlug),
    sourceDateIdx: index('entity_activity_observations_source_date_idx').on(
      table.source,
      table.observationDate,
    ),
    dateIdx: index('entity_activity_observations_date_idx').on(table.observationDate),
    uniq: unique().on(table.entitySlug, table.source, table.observationDate),
  }),
);

export type EntityActivityObservation = typeof entityActivityObservations.$inferSelect;
export type NewEntityActivityObservation = typeof entityActivityObservations.$inferInsert;
