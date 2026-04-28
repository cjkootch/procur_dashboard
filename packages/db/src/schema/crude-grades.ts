import {
  pgTable,
  uuid,
  text,
  numeric,
  boolean,
  jsonb,
  timestamp,
  index,
} from 'drizzle-orm/pg-core';

/**
 * Reference table of physical crude grades (oil streams) and their
 * material properties — what determines whether a given refinery can
 * actually run a cargo of this grade.
 *
 * Why this exists: the rolodex tells us "these refineries exist";
 * known_entities.metadata.slate (set on individual refinery rows) tells
 * us "this refinery can run light-sweet up to X% sulfur"; THIS table
 * tells us "Es Sider is 37° API, 0.4% sulfur, low TAN, paraffinic".
 * Joining the two answers "which refineries can run Es Sider?".
 *
 * Curated reference data (not scraped). Re-seeded from
 * `seed-crude-grades.ts` — additions land via PR.
 *
 * Public-domain. Shared across tenants. No companyId scoping.
 */
export const crudeGrades = pgTable(
  'crude_grades',
  {
    /** Stable url-safe identifier — used for re-seed idempotency. */
    slug: text('slug').primaryKey(),
    /** Display name, e.g. "Es Sider", "Bonny Light", "Brent". */
    name: text('name').notNull(),
    /** ISO-2 country of production. NULL for marker grades like Brent
        that are pricing benchmarks rather than physical streams. */
    originCountry: text('origin_country'),
    /** Region grouping for filters: 'mediterranean' | 'west-africa' |
        'gulf' | 'caspian' | 'asia-pacific' | 'americas' | 'north-sea'. */
    region: text('region'),

    /** Density. Light = 30+, medium = 22-30, heavy < 22. */
    apiGravity: numeric('api_gravity'),
    /** Sulfur content. Sweet < 0.5%, sour > 0.5%. */
    sulfurPct: numeric('sulfur_pct'),
    /** Total acid number (mg KOH/g). > 0.5 starts to require corrosion-
        resistant metallurgy; > 1.0 is "high TAN" specialty. */
    tan: numeric('tan'),
    /** 'paraffinic' | 'naphthenic' | 'aromatic' | 'mixed'. Affects
        product yield slate. */
    characterization: text('characterization'),

    /** True for pricing benchmarks (Brent, WTI, Dubai, Urals). False
        for ordinary trade grades. Marker grades are quoted on
        exchanges; non-marker grades trade as differentials to a marker. */
    isMarker: boolean('is_marker').notNull().default(false),
    /** ISO-2 country of the export terminal (where the grade actually
        loads). Often equals origin_country, but sometimes a grade
        loads from a different country (e.g. Kazakh CPC blend exports
        from Russia). */
    loadingCountry: text('loading_country'),

    /** Editorial line — pair with metadata for richer detail. */
    notes: text('notes'),
    /** Where the property figures came from: 'analyst-curated' | URL. */
    source: text('source'),

    /** Free-form details: typical_yield_pct, residue_yield_pct,
        nickel_ppm, vanadium_ppm, etc. */
    metadata: jsonb('metadata'),

    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => ({
    countryIdx: index('crude_grades_origin_country_idx').on(table.originCountry),
    regionIdx: index('crude_grades_region_idx').on(table.region),
    markerIdx: index('crude_grades_marker_idx').on(table.isMarker),
  }),
);

export type CrudeGrade = typeof crudeGrades.$inferSelect;
export type NewCrudeGrade = typeof crudeGrades.$inferInsert;
