/**
 * Power-generation fuel-consumption signal derivation.
 *
 * Reads existing GEM-ingested power plants from `known_entities`
 * (role = 'power-plant') and converts capacity + fuel + status into
 * `power_capacity` rows on `fuel_consumption_signals`.
 *
 * Why this isn't hand-curated like seed-fuel-consumption-signals:
 * the data already lives in procur via `ingest-gem-power-plants`.
 * Hand-typing 100s of plants from GEM into a seed file would
 * duplicate the source of truth and rot the moment GEM publishes
 * an update. Instead this script joins known_entities to the
 * fuel_intensity_factors table and writes one signal per plant.
 *
 * Method:
 *   bbl_yr = capacity_MW × 8760 h/yr × utilization × L/MWh ÷ 158.987
 *
 * Utilization bands by classified plant type (Caribbean-tuned):
 *   - hfo_baseload:  45-65%  (T&T, JPS, AES Dominicana, Curaçao)
 *   - mixed_oil:     30-55%  (dual diesel + HFO)
 *   - diesel_peaker:  8-20%  (standby + peaking gensets)
 *
 * Confidence: 0.5 — two estimates stacked (utilization band +
 * intensity factor band). Lower than the 0.7 mining-production
 * signals that started from a published production figure.
 *
 * Idempotent — DELETEs then INSERTs on
 * (entity_slug, source, coverage_year).
 *
 * Skipped:
 *   - plants without operating status (pre-construction, announced)
 *   - plants without capacity_mw or with capacity_mw <= 0
 *   - pure-gas plants (GEM ingest already filters these unless
 *     --include-gas, but defend against it here too)
 *
 * Run:
 *   pnpm --filter @procur/db derive-fuel-signals-power-gen
 *   pnpm --filter @procur/db derive-fuel-signals-power-gen --dry-run
 *   pnpm --filter @procur/db derive-fuel-signals-power-gen --country=JM
 */
import 'dotenv/config';
import { config as loadEnv } from 'dotenv';
import { sql } from 'drizzle-orm';
import { db } from './client';

loadEnv({ path: '../../.env.local' });
loadEnv({ path: '../../.env' });

const L_PER_BBL = 158.987;
const HOURS_PER_YEAR = 8760;
const COVERAGE_YEAR = 2024;
const CONFIDENCE = 0.5;

type Classification = 'hfo_baseload' | 'mixed_oil' | 'diesel_peaker';

type ClassifiedPlant = {
  entitySlug: string;
  name: string;
  country: string;
  capacityMw: number;
  fuels: string[];
  statuses: string[];
  classification: Classification;
  oilFraction: number;
  utilizationMin: number;
  utilizationMax: number;
  intensitySlug: 'power-gen-hfo-baseload' | 'power-gen-diesel-peaker';
};

const HFO_RE = /(fuel oil|residual|heavy fuel)/i;
// "fossil liquids" without a colon-qualified subtype = generic — assume HFO,
// which is the dominant Caribbean baseload pattern.
const GENERIC_LIQUIDS_RE = /fossil liquids(?!\s*:)/i;
const DIESEL_RE = /(diesel|gas oil)/i;
const GAS_RE = /\b(natural gas|fossil gas|lng|cng)\b/i;

function fuelsHasHfo(fuels: string[]): boolean {
  return fuels.some((f) => HFO_RE.test(f) || GENERIC_LIQUIDS_RE.test(f));
}
function fuelsHasDiesel(fuels: string[]): boolean {
  return fuels.some((f) => DIESEL_RE.test(f));
}
function fuelsHasGas(fuels: string[]): boolean {
  return fuels.some((f) => GAS_RE.test(f));
}

function classify(fuels: string[]): {
  classification: Classification;
  oilFraction: number;
} | null {
  const hfo = fuelsHasHfo(fuels);
  const diesel = fuelsHasDiesel(fuels);
  const gas = fuelsHasGas(fuels);

  // Pure gas — shouldn't happen given the GEM ingest filter, but guard.
  if (!hfo && !diesel) return null;

  // Dual-fuel split: if the plant also burns gas, assume ~50% of
  // capacity goes to oil. Pure-oil plants get full attribution.
  const oilFraction = gas ? 0.5 : 1.0;

  if (hfo && diesel) return { classification: 'mixed_oil', oilFraction };
  if (hfo) return { classification: 'hfo_baseload', oilFraction };
  return { classification: 'diesel_peaker', oilFraction };
}

function utilizationBand(c: Classification): { min: number; max: number } {
  switch (c) {
    case 'hfo_baseload':
      return { min: 0.45, max: 0.65 };
    case 'mixed_oil':
      return { min: 0.3, max: 0.55 };
    case 'diesel_peaker':
      return { min: 0.08, max: 0.2 };
  }
}

function intensitySlugFor(c: Classification): ClassifiedPlant['intensitySlug'] {
  // Mixed-oil plants run HFO as their bulk fuel with diesel as the
  // start-up / trim layer — HFO factor is the right anchor.
  return c === 'diesel_peaker'
    ? 'power-gen-diesel-peaker'
    : 'power-gen-hfo-baseload';
}

type FactorRow = {
  slug: string;
  liters_per_unit_min: string | null;
  liters_per_unit_max: string | null;
  liters_per_unit: string;
};

async function loadIntensityFactors(): Promise<
  Record<string, { min: number; mid: number; max: number }>
> {
  const rows = (await db.execute(sql`
    SELECT slug, liters_per_unit, liters_per_unit_min, liters_per_unit_max
      FROM fuel_intensity_factors
     WHERE slug IN ('power-gen-hfo-baseload', 'power-gen-diesel-peaker');
  `)) as unknown as FactorRow[];
  const out: Record<string, { min: number; mid: number; max: number }> = {};
  for (const r of rows) {
    const mid = Number(r.liters_per_unit);
    out[r.slug] = {
      min: r.liters_per_unit_min != null ? Number(r.liters_per_unit_min) : mid,
      mid,
      max: r.liters_per_unit_max != null ? Number(r.liters_per_unit_max) : mid,
    };
  }
  return out;
}

type PlantRow = {
  slug: string;
  name: string;
  country: string;
  metadata: {
    capacity_mw?: number | null;
    fuels?: string[] | null;
    statuses?: string[] | null;
  } | null;
};

async function loadPlants(countryFilter: string | null): Promise<PlantRow[]> {
  const result = countryFilter
    ? await db.execute(sql`
        SELECT slug, name, country, metadata
          FROM known_entities
         WHERE role = 'power-plant'
           AND country = ${countryFilter};
      `)
    : await db.execute(sql`
        SELECT slug, name, country, metadata
          FROM known_entities
         WHERE role = 'power-plant';
      `);
  return result as unknown as PlantRow[];
}

function classifyPlant(p: PlantRow): ClassifiedPlant | null {
  const m = p.metadata ?? {};
  const capacity = typeof m.capacity_mw === 'number' ? m.capacity_mw : null;
  if (capacity == null || capacity <= 0) return null;

  const fuels = Array.isArray(m.fuels) ? m.fuels.filter((x) => typeof x === 'string') : [];
  const statuses = Array.isArray(m.statuses)
    ? m.statuses.filter((x) => typeof x === 'string')
    : [];
  if (statuses.length > 0 && !statuses.some((s) => s.toLowerCase() === 'operating')) {
    return null;
  }

  const cls = classify(fuels);
  if (!cls) return null;

  const band = utilizationBand(cls.classification);
  return {
    entitySlug: p.slug,
    name: p.name,
    country: p.country,
    capacityMw: capacity,
    fuels,
    statuses,
    classification: cls.classification,
    oilFraction: cls.oilFraction,
    utilizationMin: band.min,
    utilizationMax: band.max,
    intensitySlug: intensitySlugFor(cls.classification),
  };
}

function deriveBblBand(
  plant: ClassifiedPlant,
  factor: { min: number; max: number },
): { min: number; max: number } {
  const minMwh =
    plant.capacityMw * HOURS_PER_YEAR * plant.utilizationMin * plant.oilFraction;
  const maxMwh =
    plant.capacityMw * HOURS_PER_YEAR * plant.utilizationMax * plant.oilFraction;
  return {
    min: (minMwh * factor.min) / L_PER_BBL,
    max: (maxMwh * factor.max) / L_PER_BBL,
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const countryArg = args.find((a) => a.startsWith('--country='));
  const countryFilter = countryArg ? (countryArg.split('=')[1] ?? '').toUpperCase() || null : null;

  console.log(
    `derive-fuel-signals-power-gen — dryRun=${dryRun}, country=${countryFilter ?? 'ALL'}`,
  );

  const factors = await loadIntensityFactors();
  const hfoFactor = factors['power-gen-hfo-baseload'];
  const dieselFactor = factors['power-gen-diesel-peaker'];
  if (!hfoFactor || !dieselFactor) {
    throw new Error(
      'Missing intensity factors. Run pnpm --filter @procur/db ' +
        'seed-fuel-consumption-signals first.',
    );
  }
  const factorBySlug: Record<ClassifiedPlant['intensitySlug'], { min: number; max: number }> = {
    'power-gen-hfo-baseload': hfoFactor,
    'power-gen-diesel-peaker': dieselFactor,
  };

  const plants = await loadPlants(countryFilter);
  console.log(`  loaded ${plants.length} power-plant rows from known_entities`);

  let classified = 0;
  let skipped = 0;
  let inserted = 0;
  const skipReasons = new Map<string, number>();
  const byClass: Record<Classification, number> = {
    hfo_baseload: 0,
    mixed_oil: 0,
    diesel_peaker: 0,
  };
  const byCountry = new Map<string, { count: number; bblMin: number; bblMax: number }>();

  for (const p of plants) {
    const c = classifyPlant(p);
    if (!c) {
      skipped += 1;
      const reason = !p.metadata?.capacity_mw
        ? 'no_capacity'
        : !p.metadata?.statuses?.some((s) => s.toLowerCase() === 'operating')
          ? 'not_operating'
          : 'no_oil_fuel';
      skipReasons.set(reason, (skipReasons.get(reason) ?? 0) + 1);
      continue;
    }
    classified += 1;
    byClass[c.classification] += 1;

    const factor = factorBySlug[c.intensitySlug];
    const band = deriveBblBand(c, factor);

    const country = byCountry.get(c.country) ?? { count: 0, bblMin: 0, bblMax: 0 };
    country.count += 1;
    country.bblMin += band.min;
    country.bblMax += band.max;
    byCountry.set(c.country, country);

    if (dryRun) continue;

    const rawData = {
      scale: { unit: 'mwh_generated', value: Math.round(c.capacityMw * HOURS_PER_YEAR) },
      intensitySlug: c.intensitySlug,
      classification: c.classification,
      capacityMw: c.capacityMw,
      utilization: { min: c.utilizationMin, max: c.utilizationMax },
      oilFraction: c.oilFraction,
      fuels: c.fuels,
      statuses: c.statuses,
      derivedFrom: `${c.capacityMw} MW × 8760 h × ${c.utilizationMin}-${c.utilizationMax} util × ${c.oilFraction} oil-share × ${factor.min}-${factor.max} L/MWh`,
    };

    await db.execute(sql`
      DELETE FROM fuel_consumption_signals
       WHERE entity_slug = ${c.entitySlug}
         AND source = 'power_capacity'
         AND coverage_year = ${COVERAGE_YEAR};
    `);
    await db.execute(sql`
      INSERT INTO fuel_consumption_signals (
        entity_slug, source, volume_bbl_yr_min, volume_bbl_yr_max,
        confidence, coverage_year, notes, source_url, raw_data
      ) VALUES (
        ${c.entitySlug},
        'power_capacity',
        ${band.min.toFixed(2)},
        ${band.max.toFixed(2)},
        ${CONFIDENCE},
        ${COVERAGE_YEAR},
        ${`${c.name}: ${c.capacityMw.toLocaleString()} MW ${c.classification.replace('_', ' ')} plant. Oil-share ${Math.round(c.oilFraction * 100)}%, capacity factor ${Math.round(c.utilizationMin * 100)}-${Math.round(c.utilizationMax * 100)}%.`},
        ${'https://globalenergymonitor.org/projects/global-oil-gas-plant-tracker/'},
        ${JSON.stringify(rawData)}::jsonb
      );
    `);
    inserted += 1;
  }

  console.log(`\nClassified ${classified} plants, skipped ${skipped}.`);
  console.log('  by classification:');
  for (const [k, n] of Object.entries(byClass)) console.log(`    ${k}: ${n}`);
  console.log('  skip reasons:');
  for (const [k, n] of skipReasons) console.log(`    ${k}: ${n}`);

  console.log('\n  by country (top 10 by max bbl/yr):');
  const top = [...byCountry.entries()]
    .sort((a, b) => b[1].bblMax - a[1].bblMax)
    .slice(0, 10);
  for (const [cc, agg] of top) {
    console.log(
      `    ${cc}: ${agg.count} plants, ${(agg.bblMin / 1e6).toFixed(2)}-${(agg.bblMax / 1e6).toFixed(2)}M bbl/yr`,
    );
  }

  if (dryRun) {
    console.log('\n(dry run — no rows written.)');
  } else {
    console.log(`\nInserted ${inserted} power_capacity signal rows.`);
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
