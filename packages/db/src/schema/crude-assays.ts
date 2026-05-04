import {
  pgTable,
  uuid,
  text,
  numeric,
  date,
  jsonb,
  timestamp,
  integer,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

/**
 * Crude assay header — one row per (source, reference). Whole-crude
 * scalar properties + provenance + best-effort linkage to
 * `crude_grades.slug`. The TBP cut breakdown lives in
 * `crude_assay_cuts` (FK on assay_id).
 *
 * Why this is separate from `crude_grades`:
 *   - `crude_grades` is curated reference data — one row per marker
 *     / trade grade, hand-edited via PR.
 *   - `crude_assays` is producer evidence — multiple rows per grade
 *     possible (e.g. ExxonMobil, BP, TotalEnergies, and Equinor all
 *     publish their own Brent Blend assay).
 *
 * Source vocabulary (text, not enum so additions don't need a
 * migration): 'exxonmobil' | 'bp' | 'equinor' | 'totalenergies' |
 * 'qarat' for current ingest; future producers (Shell, ENI,
 * Aramco) just land with a new value.
 *
 * Idempotency: the ingest script writes
 * `ON CONFLICT (source, reference) DO UPDATE` so re-running after a
 * producer publishes a new vintage replaces the row in place.
 */
export const crudeAssays = pgTable(
  'crude_assays',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    // Provenance
    source: text('source').notNull(),
    reference: text('reference').notNull(),
    sourceFile: text('source_file'),

    // Identity
    name: text('name').notNull(),
    /** Best-effort link to crude_grades.slug. NULL when no obvious
     *  match — the assay still lands and a follow-up can link it. */
    gradeSlug: text('grade_slug'),

    // Origin
    /** ISO-2. NULL when origin not parseable. */
    originCountry: text('origin_country'),
    /** Free-text origin label as published ("North Sea - UK", etc.). */
    originLabel: text('origin_label'),

    // Dates
    sampleDate: date('sample_date'),
    assayDate: date('assay_date'),
    issueDate: date('issue_date'),

    // Whole-crude scalar properties — all nullable.
    densityKgL: numeric('density_kg_l'),
    apiGravity: numeric('api_gravity'),
    bblPerMt: numeric('bbl_per_mt'),
    sulphurWtPct: numeric('sulphur_wt_pct'),
    pourPointC: numeric('pour_point_c'),
    /** Total acid number (TAN), mg KOH/g. */
    acidityMgKohG: numeric('acidity_mg_koh_g'),
    vanadiumMgKg: numeric('vanadium_mg_kg'),
    nickelMgKg: numeric('nickel_mg_kg'),
    nitrogenMgKg: numeric('nitrogen_mg_kg'),
    rvpKpa: numeric('rvp_kpa'),
    viscosityCst20c: numeric('viscosity_cst_20c'),
    viscosityCst50c: numeric('viscosity_cst_50c'),
    mercaptanSulphurMgKg: numeric('mercaptan_sulphur_mg_kg'),
    h2sMgKg: numeric('h2s_mg_kg'),
    waxAppearanceTempC: numeric('wax_appearance_temp_c'),

    comments: text('comments'),
    /** Full parsed summary block — preserves any field we don't model
     *  as a column so a follow-up can mine it without re-parsing. */
    raw: jsonb('raw'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    sourceRefUniq: uniqueIndex('crude_assays_source_ref_uniq').on(t.source, t.reference),
    nameIdx: index('crude_assays_name_idx').on(t.name),
    gradeIdx: index('crude_assays_grade_idx').on(t.gradeSlug),
    countryIdx: index('crude_assays_country_idx').on(t.originCountry),
  }),
);

export type CrudeAssay = typeof crudeAssays.$inferSelect;
export type NewCrudeAssay = typeof crudeAssays.$inferInsert;

/**
 * Per-cut yields and properties. One row per TBP cut (light naphtha
 * → vacuum residue), ordered by `cutOrder` ascending.
 *
 * Cut taxonomy is intentionally free-text. Producers don't agree on
 * a fixed cut vocabulary — TotalEnergies splits "Naphtha" into
 * Light/Heavy, BP uses "Light Naphtha" + "Heavy Naphtha" + "Kero",
 * Haverly-format reports (ExxonMobil, Equinor) emit cut start/end
 * temperatures rather than fixed labels. Storing the producer's
 * label verbatim lets us preserve fidelity; downstream consumers
 * can map to a common vocabulary using start_temp_c / end_temp_c.
 */
export const crudeAssayCuts = pgTable(
  'crude_assay_cuts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    assayId: uuid('assay_id')
      .notNull()
      .references(() => crudeAssays.id, { onDelete: 'cascade' }),

    cutLabel: text('cut_label').notNull(),
    cutOrder: integer('cut_order').notNull(),

    startTempC: numeric('start_temp_c'),
    endTempC: numeric('end_temp_c'),

    yieldWtPct: numeric('yield_wt_pct'),
    yieldVolPct: numeric('yield_vol_pct'),
    cumulativeYieldWtPct: numeric('cumulative_yield_wt_pct'),

    densityKgL: numeric('density_kg_l'),
    sulphurWtPct: numeric('sulphur_wt_pct'),

    /** Raw cell map for fields we don't model (per-cut viscosity,
     *  smoke point, freeze point, mercaptan, etc.). */
    raw: jsonb('raw'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    assayIdx: index('crude_assay_cuts_assay_idx').on(t.assayId),
  }),
);

export type CrudeAssayCut = typeof crudeAssayCuts.$inferSelect;
export type NewCrudeAssayCut = typeof crudeAssayCuts.$inferInsert;
