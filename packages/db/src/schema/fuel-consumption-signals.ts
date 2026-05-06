import {
  pgTable,
  uuid,
  text,
  timestamp,
  numeric,
  integer,
  jsonb,
  date,
  index,
} from 'drizzle-orm/pg-core';

/**
 * Per-entity annual fuel consumption signals derived from external
 * data sources we can convert into bbl/yr ranges. Each row = one
 * signal from one source. Multiple rows per entity weighted by
 * confidence at query time.
 *
 * The entity_slug is text (not FK) so it accepts both
 * known_entities.slug and external_suppliers.id (UUID) — same
 * canonical-key shape getEntityProfile uses.
 *
 * Sources rolled out in priority order:
 *   - mining_production (first — highest leverage per Caribbean
 *     bauxite case study)
 *   - cdp / gri (ESG self-reported emissions)
 *   - power_capacity (MW × utilization × intensity)
 *   - port_bunkers (port authority disclosures)
 *   - subsidy_allocation (gov't fuel-subsidy programs)
 *   - ais_inferred (vessel dwell + bunker uplift estimate)
 *   - analyst_estimate (manually curated)
 */
export const fuelConsumptionSignals = pgTable(
  'fuel_consumption_signals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    entitySlug: text('entity_slug').notNull(),

    /** Where this signal came from. New values added by
     *  application code — no enum constraint. */
    source: text('source').notNull(),

    /** What kind of evidence this signal carries — added per
     *  buyer-intelligence-v2-free-sources-brief.md §3.1:
     *    'volume_estimate'      — direct or derived bbl/yr figure
     *    'capacity_signal'      — MW × utilization → derived bbl/yr
     *    'expenditure_signal'   — $ spend ÷ benchmark price → bbl/yr
     *    'activity_signal'      — proxy (e.g. nighttime lights,
     *                             port-call days) without bbl/yr math
     *  Free text — no enum so new kinds slot in without migration. */
    signalKind: text('signal_kind'),

    /** Which refined-product family the signal applies to:
     *    'diesel' | 'hfo' | 'mgo' | 'jet' | 'gasoline' | 'mixed'
     *  NULL when the source doesn't disaggregate (mining
     *  production-derived signals are usually mixed
     *  diesel + HFO). */
    fuelType: text('fuel_type'),

    /** Annual fuel volume range in barrels. min == max for point
     *  estimates; both null for qualitative-only signals. */
    volumeBblYrMin: numeric('volume_bbl_yr_min', { precision: 20, scale: 2 }),
    volumeBblYrMax: numeric('volume_bbl_yr_max', { precision: 20, scale: 2 }),

    /** 0-1 confidence band:
     *    1.0 — published by the entity itself (CDP, 10-K, ESG)
     *    0.7 — derived from operational data + standard intensity
     *    0.4 — analyst guess without published anchor */
    confidence: numeric('confidence', { precision: 3, scale: 2 }),

    asOfDate: date('as_of_date').notNull().defaultNow(),
    coverageYear: integer('coverage_year'),

    notes: text('notes'),
    sourceUrl: text('source_url'),

    /** Source-specific underlying data — scale figure + intensity
     *  factor + conversion. Lets us re-run the calc when factors
     *  update without re-scraping. */
    rawData: jsonb('raw_data'),

    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => ({
    entityIdx: index('fuel_consumption_signals_entity_idx').on(table.entitySlug),
    sourceIdx: index('fuel_consumption_signals_source_idx').on(table.source),
    coverageYearIdx: index('fuel_consumption_signals_coverage_year_idx').on(
      table.coverageYear,
    ),
    fuelTypeIdx: index('fuel_consumption_signals_fuel_type_idx').on(table.fuelType),
  }),
);

export type FuelConsumptionSignal = typeof fuelConsumptionSignals.$inferSelect;
export type NewFuelConsumptionSignal = typeof fuelConsumptionSignals.$inferInsert;

/**
 * Industry-standard intensity coefficients. Static reference
 * table — analyst-curated. References from raw_data on signal
 * rows so the calc is auditable.
 */
export const fuelIntensityFactors = pgTable(
  'fuel_intensity_factors',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slug: text('slug').notNull().unique(),
    name: text('name').notNull(),

    /** Scale unit this factor converts:
     *    'tonnes_ore' | 'mwh_generated' | 'flight_hours'
     *    | 'hectares_planted' | 'occupied_room_nights' | 'mt_cement'
     *    | 'tonnes_steel' | etc. */
    scaleUnit: text('scale_unit').notNull(),

    /** Liters of diesel-equivalent per scale unit (mid-range). */
    litersPerUnit: numeric('liters_per_unit', { precision: 14, scale: 4 }).notNull(),
    litersPerUnitMin: numeric('liters_per_unit_min', { precision: 14, scale: 4 }),
    litersPerUnitMax: numeric('liters_per_unit_max', { precision: 14, scale: 4 }),

    source: text('source'),
    sourceUrl: text('source_url'),
    notes: text('notes'),

    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => ({
    slugIdx: index('fuel_intensity_factors_slug_idx').on(table.slug),
  }),
);

export type FuelIntensityFactor = typeof fuelIntensityFactors.$inferSelect;
export type NewFuelIntensityFactor = typeof fuelIntensityFactors.$inferInsert;
