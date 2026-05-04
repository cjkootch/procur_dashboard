import { z } from 'zod';

/**
 * Structured refinery slate capability — what crudes a refinery can
 * actually run, encoded as numeric envelopes that join cleanly
 * against `crude_grades` properties for deterministic compatibility
 * matching.
 *
 * Stored under `known_entities.metadata.slate`. Curated reference
 * data (not scraped) — populated by `seed-refinery-slate.ts` for the
 * top 60-80 refineries in the rolodex; the long tail stays unstructured
 * until commercially relevant.
 *
 * Why structured (vs free-text notes): the `refinery_grade_compatibility`
 * view (migration 0057) joins this against `crude_grades` to produce
 * (refinery × grade) fit booleans without manual cross-referencing.
 * Without structure, every "which refineries can run Es Sider" query
 * is a manual lookup; with structure, it's a SQL filter.
 *
 * All fields are optional — partial population is supported. The
 * compatibility view treats missing dimensions as "permissive" (no
 * constraint), so a slate with only `apiMin/apiMax/sulfurMaxPct` set
 * still produces a useful compatibility row.
 */
export const refinerySlateCapabilitySchema = z.object({
  /** Minimum crude API gravity the refinery can efficiently run.
   *  Below this, the slate is too heavy for the configuration. */
  apiMin: z.number().optional(),
  /** Maximum crude API gravity. Above this, the slate is too light
   *  (insufficient residue feed for the cracking train). */
  apiMax: z.number().optional(),

  /** Maximum sulfur content (% wt) the desulfurization train can
   *  handle. e.g. 0.5 for sweet-only refineries, 3.5 for full sour. */
  sulfurMaxPct: z.number().optional(),

  /** Maximum total acid number (mg KOH/g). > 0.5 starts requiring
   *  corrosion-resistant metallurgy; > 1.0 is high-TAN specialty
   *  configuration. NULL on the slate means "TAN tolerance not
   *  characterized" — view treats absence as permissive. */
  tanMax: z.number().optional(),

  /** Maximum heavy-metals content (ppm wt) the catalysts tolerate.
   *  Critical for high-V/Ni grades (e.g. Maya, WCS); irrelevant for
   *  light sweets. */
  vanadiumMaxPpm: z.number().optional(),
  nickelMaxPpm: z.number().optional(),

  /** Whether the refinery has acidic-tolerant metallurgy throughout.
   *  Independent of `tanMax` — a refinery may have a TAN ceiling
   *  for routine operation but accept higher TAN slugs as blend
   *  components if metallurgy permits. */
  acidicTolerance: z.boolean().optional(),

  /** Crude unit nameplate capacity, barrels per day. Drives
   *  cargo-size scaling (a 50k-bpd unit cannot absorb a VLCC). */
  crudeUnitCapacityBpd: z.number().optional(),

  /** Nelson Complexity Index. > 12 is high-conversion (FCC + coker
   *  + hydrocracker + alkylation); 6-9 is mid-complexity; < 6 is
   *  hydroskimming. Drives the product-economics calculation
   *  used by the future `calculate_refining_economics` tool. */
  complexityIndex: z.number().optional(),

  /** Free-text notes on capability nuances that don't fit the
   *  numeric envelope (e.g. "can blend up to 30% heavy sour",
   *  "Mellitah JV preferential access to Es Sider"). */
  notes: z.string().optional(),
});

export type RefinerySlateCapability = z.infer<typeof refinerySlateCapabilitySchema>;

/**
 * Best-effort extraction of a slate object from a free-form
 * `known_entities.metadata` blob. Tolerates the legacy snake_case
 * keys (`min_api`, `max_api`, `max_sulfur_pct`, `source_notes`) by
 * converting on read — production rows seeded before the schema
 * tightening still parse cleanly. Returns `null` when no slate is
 * present.
 */
export function readSlateCapability(
  metadata: unknown,
): RefinerySlateCapability | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const m = metadata as Record<string, unknown>;
  const raw = m.slate;
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as Record<string, unknown>;

  // Accept either camelCase or snake_case from a previous seed
  // version. New writes always use camelCase; readers tolerate both.
  const candidate = {
    apiMin: numericFrom(s.apiMin ?? s.min_api),
    apiMax: numericFrom(s.apiMax ?? s.max_api),
    sulfurMaxPct: numericFrom(s.sulfurMaxPct ?? s.max_sulfur_pct),
    tanMax: numericFrom(s.tanMax ?? s.tan_max),
    vanadiumMaxPpm: numericFrom(s.vanadiumMaxPpm ?? s.vanadium_max_ppm),
    nickelMaxPpm: numericFrom(s.nickelMaxPpm ?? s.nickel_max_ppm),
    acidicTolerance:
      typeof s.acidicTolerance === 'boolean'
        ? s.acidicTolerance
        : typeof s.acidic_tolerance === 'boolean'
          ? s.acidic_tolerance
          : undefined,
    crudeUnitCapacityBpd: numericFrom(s.crudeUnitCapacityBpd ?? s.crude_unit_capacity_bpd),
    complexityIndex: numericFrom(s.complexityIndex ?? s.complexity_index),
    notes: typeof s.notes === 'string'
      ? s.notes
      : typeof s.source_notes === 'string'
        ? s.source_notes
        : undefined,
  };

  const parsed = refinerySlateCapabilitySchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

function numericFrom(v: unknown): number | undefined {
  if (v == null) return undefined;
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}
