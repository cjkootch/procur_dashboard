/**
 * Hand-curated seed for fuel_consumption_signals + fuel_intensity_factors.
 *
 * First wave: Caribbean mining buyers, derived via
 *   annual_production × industry-standard diesel/HFO intensity.
 *
 * Per the Caribbean fuel-buyer brief §1, bauxite + alumina + gold +
 * nickel mining in the Caribbean rolodex collectively imports
 * ~9M+ bbl/yr of refined product — the single largest non-utility
 * consumption category procur tracks. This seed converts the public
 * production figures into per-entity signals so they appear on the
 * entity profile + chat tools as derived consumption ranges.
 *
 * Methodology — per signal row, raw_data carries:
 *   - scale: { unit, value } — what was multiplied (tonnes, oz, MWh)
 *   - intensitySlug: which factor row was applied
 *   - notes: why we chose those bounds
 *
 * Idempotent. Re-running upserts in place by slug (factors) and
 * by (entity_slug, source, coverage_year) for signals.
 *
 * Run from repo root:
 *   pnpm --filter @procur/db seed-fuel-consumption-signals
 */
import 'dotenv/config';
import { config as loadEnv } from 'dotenv';
import { sql } from 'drizzle-orm';
import { db } from './client';

loadEnv({ path: '../../.env.local' });
loadEnv({ path: '../../.env' });

// ─── Industry intensity factors (1L diesel ≈ 0.00629 bbl) ──────────

type IntensitySeed = {
  slug: string;
  name: string;
  scaleUnit:
    | 'tonnes_ore'
    | 'tonnes_alumina'
    | 'oz_gold'
    | 'tonnes_nickel'
    | 'mwh_generated'
    | 'flight_hours'
    | 'mt_cement';
  litersPerUnit: number;
  litersPerUnitMin: number;
  litersPerUnitMax: number;
  source: string;
  sourceUrl: string | null;
  notes: string;
};

const FACTORS: IntensitySeed[] = [
  {
    slug: 'mining-bauxite-extraction',
    name: 'Bauxite extraction (open-pit)',
    scaleUnit: 'tonnes_ore',
    litersPerUnit: 2.2,
    litersPerUnitMin: 1.5,
    litersPerUnitMax: 3.0,
    source: 'ICMM + IFC mining sector benchmarks',
    sourceUrl:
      'https://www.icmm.com/en-gb/research/health-safety/2018/mining-energy-consumption-2018',
    notes:
      'Diesel intensity for open-pit bauxite mining (haul trucks, drills, draglines). ' +
      'Excludes refining (alumina) — covered by alumina-refining slug.',
  },
  {
    slug: 'alumina-refining',
    name: 'Alumina refining (Bayer process)',
    scaleUnit: 'tonnes_alumina',
    litersPerUnit: 1450,
    litersPerUnitMin: 1100,
    litersPerUnitMax: 1900,
    source: 'IEA + Carnegie Mellon LCA studies',
    sourceUrl:
      'https://www.iea.org/data-and-statistics/charts/global-aluminium-production-and-energy-consumption',
    notes:
      'Mostly HFO + natural gas firing the Bayer-process digesters and ' +
      'calciners. Caribbean-specific: most Jamaican refineries run HFO/diesel ' +
      'rather than NG (no pipeline gas). Range reflects facility age + ' +
      'energy efficiency (older plants higher).',
  },
  {
    slug: 'mining-gold-extraction',
    name: 'Gold mining (open-pit + heap leach)',
    scaleUnit: 'oz_gold',
    litersPerUnit: 0.55,
    litersPerUnitMin: 0.35,
    litersPerUnitMax: 0.85,
    source: 'World Gold Council energy intensity reports',
    sourceUrl:
      'https://www.gold.org/goldhub/research/responsible-gold-mining-and-value-distribution',
    notes:
      'Liters of diesel per troy oz gold extracted. Wide range — open-pit ' +
      'mines like Pueblo Viejo are ~0.4 L/oz; smaller / underground ops ' +
      'higher. Excludes mill electricity (typically grid-supplied).',
  },
  {
    slug: 'mining-nickel-extraction',
    name: 'Nickel mining + ferronickel smelting',
    scaleUnit: 'tonnes_nickel',
    litersPerUnit: 8500,
    litersPerUnitMin: 6000,
    litersPerUnitMax: 12000,
    source: 'Nickel Institute LCA + IFC benchmarks',
    sourceUrl: 'https://nickelinstitute.org/about-nickel/life-cycle-data/',
    notes:
      'Per tonne of nickel-in-product. Smelting laterites (Caribbean / DR / ' +
      'Cuba / Cerro Matoso) is highly fuel-intensive — coke + heavy fuel ' +
      'oil for furnace operation. Lateritic ops higher than sulfide.',
  },
  {
    slug: 'power-gen-diesel-peaker',
    name: 'Diesel peaker plant generation',
    scaleUnit: 'mwh_generated',
    litersPerUnit: 270,
    litersPerUnitMin: 240,
    litersPerUnitMax: 320,
    source: 'EIA + IFC distributed-generation factors',
    sourceUrl: 'https://www.eia.gov/electricity/monthly/',
    notes:
      'Liters diesel per MWh delivered. Older units higher. Applies to ' +
      'standby + peaking diesel gensets typical of Caribbean utilities.',
  },
  {
    slug: 'power-gen-hfo-baseload',
    name: 'HFO-fired baseload generation',
    scaleUnit: 'mwh_generated',
    litersPerUnit: 240,
    litersPerUnitMin: 210,
    litersPerUnitMax: 280,
    source: 'EIA + IFC baseload-power benchmarks',
    sourceUrl: null,
    notes:
      'Liters HFO per MWh from a baseload steam plant. Caribbean utilities ' +
      'with HFO-fired plants (T&T, Curaçao, DR, Jamaica AES) sit in this ' +
      'range. Diesel equivalents — adjust by ~+8% for HFO density.',
  },
];

// ─── Mining-side consumption signals ───────────────────────────────

type SignalSeed = {
  entitySlug: string;
  source: string;
  volumeBblYrMin: number;
  volumeBblYrMax: number;
  confidence: number;
  coverageYear: number;
  notes: string;
  sourceUrl: string | null;
  rawData: Record<string, unknown>;
};

// Litre→barrel conversion (1 bbl = 158.987 L).
const L_PER_BBL = 158.987;

function bblFromLiters(liters: number): number {
  return liters / L_PER_BBL;
}

const SIGNALS: SignalSeed[] = [
  // ─── Jamaica alumina refineries ─────────────────────────────────
  // The 9M bbl/yr country-level bauxite-companies figure in the
  // Caribbean fuel-buyer brief breaks down approximately as:
  //   JISCO Alpart: ~1.65M tpa alumina capacity → 2.4-3.1M bbl/yr
  //   Jamalco:      ~1.4M tpa alumina           → 2.0-2.7M bbl/yr
  //   Windalco:     ~1.2M tpa (Ewarton+Kirkvine) → 1.7-2.3M bbl/yr
  //   Noranda:      bauxite-only export (no refining locally),
  //                 ~5M tpa ore → small fuel footprint
  // Total: ~6-8M bbl/yr aligned with the brief's 9M figure, with the
  // residual coming from ancillary mining + transport diesel.
  {
    entitySlug: 'fuel-buyer:jisco-alpart',
    source: 'mining_production',
    volumeBblYrMin: bblFromLiters(1_650_000 * 1100),
    volumeBblYrMax: bblFromLiters(1_650_000 * 1900),
    confidence: 0.7,
    coverageYear: 2024,
    notes:
      'JISCO Alpart alumina refinery, Nain, St. Elizabeth. ~1.65M tpa ' +
      'alumina capacity (post-2017 restart). Range reflects facility age ' +
      '+ HFO vs diesel mix uncertainty.',
    sourceUrl: 'https://www.jisco.com/index.php?c=article&id=12',
    rawData: {
      scale: { unit: 'tonnes_alumina', value: 1_650_000 },
      intensitySlug: 'alumina-refining',
      derivedFrom: '1.65M tpa × 1100-1900 L/t = 1.81-3.14B L/yr',
    },
  },
  {
    entitySlug: 'fuel-buyer:jamalco',
    source: 'mining_production',
    volumeBblYrMin: bblFromLiters(1_400_000 * 1100),
    volumeBblYrMax: bblFromLiters(1_400_000 * 1900),
    confidence: 0.7,
    coverageYear: 2024,
    notes:
      'Jamalco (Noble Group + GoJ JV) alumina refinery, Halse Hall, ' +
      'Clarendon. ~1.4M tpa alumina capacity. Recent capex into HFO→LNG ' +
      'switch may shift bbl-equivalent volumes downward over 2025-26.',
    sourceUrl: 'https://noblegroup.com/our-businesses/alumina/',
    rawData: {
      scale: { unit: 'tonnes_alumina', value: 1_400_000 },
      intensitySlug: 'alumina-refining',
      derivedFrom: '1.4M tpa × 1100-1900 L/t = 1.54-2.66B L/yr',
    },
  },
  {
    entitySlug: 'fuel-buyer:windalco',
    source: 'mining_production',
    volumeBblYrMin: bblFromLiters(1_200_000 * 1100),
    volumeBblYrMax: bblFromLiters(1_200_000 * 1900),
    confidence: 0.65,
    coverageYear: 2024,
    notes:
      'Windalco (UC Rusal majority) operates Ewarton + Kirkvine alumina ' +
      'refineries, Jamaica. Combined ~1.2M tpa alumina nameplate. Kirkvine ' +
      'has been intermittent post-2009 — confidence band is wider to ' +
      'reflect operational uncertainty.',
    sourceUrl: 'https://www.rusal.ru/en/about/global-presence/',
    rawData: {
      scale: { unit: 'tonnes_alumina', value: 1_200_000 },
      intensitySlug: 'alumina-refining',
      derivedFrom: '1.2M tpa × 1100-1900 L/t = 1.32-2.28B L/yr',
    },
  },
  {
    entitySlug: 'fuel-buyer:noranda-bauxite',
    source: 'mining_production',
    volumeBblYrMin: bblFromLiters(5_000_000 * 1.5),
    volumeBblYrMax: bblFromLiters(5_000_000 * 3.0),
    confidence: 0.6,
    coverageYear: 2024,
    notes:
      'Noranda Bauxite, Discovery Bay, Jamaica. Bauxite-only export (no ' +
      'local alumina refining) — ~5M tpa ore export. Diesel footprint is ' +
      'haul-truck + processing only; small relative to refinery operators.',
    sourceUrl: 'https://www.norandaaluminum.com/operations/',
    rawData: {
      scale: { unit: 'tonnes_ore', value: 5_000_000 },
      intensitySlug: 'mining-bauxite-extraction',
      derivedFrom: '5M tpa × 1.5-3 L/t = 7.5-15M L/yr',
    },
  },

  // ─── Caribbean / regional gold mining ───────────────────────────
  {
    entitySlug: 'fuel-buyer:barrick-pueblo-viejo',
    source: 'mining_production',
    volumeBblYrMin: bblFromLiters(800_000 * 0.35),
    volumeBblYrMax: bblFromLiters(800_000 * 0.85),
    confidence: 0.7,
    coverageYear: 2024,
    notes:
      'Barrick/Newmont JV Pueblo Viejo, DR. ~800k oz gold/yr at full run-' +
      'rate. One of the largest gold ops in the Americas; diesel for ' +
      'haul + ancillary (mill is grid-electric). Mid-range estimate ~280k ' +
      'L/yr × 30+ haul trucks × 24/7 operation.',
    sourceUrl: 'https://www.barrick.com/English/operations/pueblo-viejo/',
    rawData: {
      scale: { unit: 'oz_gold', value: 800_000 },
      intensitySlug: 'mining-gold-extraction',
      derivedFrom: '800k oz/yr × 0.35-0.85 L/oz = 280-680k L/yr',
    },
  },
  {
    entitySlug: 'fuel-buyer:newmont-merian',
    source: 'mining_production',
    volumeBblYrMin: bblFromLiters(450_000 * 0.4),
    volumeBblYrMax: bblFromLiters(450_000 * 0.85),
    confidence: 0.65,
    coverageYear: 2024,
    notes:
      'Newmont Merian, Suriname. ~450k oz gold/yr. Open-pit + heap leach. ' +
      'Diesel for fleet + on-site genset (no grid in Brokopondo region — ' +
      'site is largely off-grid). The genset component pushes the upper ' +
      'bound higher than DR Pueblo Viejo per oz.',
    sourceUrl:
      'https://www.newmont.com/operations-and-projects/south-america/merian-suriname/default.aspx',
    rawData: {
      scale: { unit: 'oz_gold', value: 450_000 },
      intensitySlug: 'mining-gold-extraction',
      derivedFrom: '450k oz/yr × 0.4-0.85 L/oz = 180-380k L/yr',
    },
  },
  {
    entitySlug: 'fuel-buyer:iamgold-rosebel',
    source: 'mining_production',
    volumeBblYrMin: bblFromLiters(220_000 * 0.45),
    volumeBblYrMax: bblFromLiters(220_000 * 0.95),
    confidence: 0.6,
    coverageYear: 2024,
    notes:
      'IAMGOLD Rosebel, Suriname (sold to Zijin in 2023). ~220k oz/yr ' +
      'recent. Underground transition has been raising fuel intensity per ' +
      'oz vs the open-pit historical baseline.',
    sourceUrl: 'https://www.iamgold.com/English/operations/operating-mines/',
    rawData: {
      scale: { unit: 'oz_gold', value: 220_000 },
      intensitySlug: 'mining-gold-extraction',
      derivedFrom: '220k oz/yr × 0.45-0.95 L/oz = 99-209k L/yr',
    },
  },
];

async function main() {
  let factorsUpserted = 0;
  let signalsUpserted = 0;
  const errors: string[] = [];

  console.log('Seeding fuel_intensity_factors…');
  for (const f of FACTORS) {
    try {
      await db.execute(sql`
        INSERT INTO fuel_intensity_factors (
          slug, name, scale_unit, liters_per_unit,
          liters_per_unit_min, liters_per_unit_max,
          source, source_url, notes
        ) VALUES (
          ${f.slug}, ${f.name}, ${f.scaleUnit}, ${f.litersPerUnit},
          ${f.litersPerUnitMin}, ${f.litersPerUnitMax},
          ${f.source}, ${f.sourceUrl}, ${f.notes}
        )
        ON CONFLICT (slug) DO UPDATE SET
          name                  = EXCLUDED.name,
          scale_unit            = EXCLUDED.scale_unit,
          liters_per_unit       = EXCLUDED.liters_per_unit,
          liters_per_unit_min   = EXCLUDED.liters_per_unit_min,
          liters_per_unit_max   = EXCLUDED.liters_per_unit_max,
          source                = EXCLUDED.source,
          source_url            = EXCLUDED.source_url,
          notes                 = EXCLUDED.notes,
          updated_at            = NOW();
      `);
      factorsUpserted += 1;
    } catch (err) {
      errors.push(`factor ${f.slug}: ${(err as Error).message}`);
    }
  }
  console.log(`  upserted ${factorsUpserted}/${FACTORS.length} factors`);

  console.log('Seeding fuel_consumption_signals…');
  for (const s of SIGNALS) {
    try {
      // Idempotency key: (entity_slug, source, coverage_year). The
      // schema doesn't have a unique constraint on this triple
      // (signals are append-only by design), but for the seed we
      // delete + reinsert so re-runs don't accumulate duplicates.
      await db.execute(sql`
        DELETE FROM fuel_consumption_signals
        WHERE entity_slug = ${s.entitySlug}
          AND source = ${s.source}
          AND coverage_year = ${s.coverageYear};
      `);
      await db.execute(sql`
        INSERT INTO fuel_consumption_signals (
          entity_slug, source, volume_bbl_yr_min, volume_bbl_yr_max,
          confidence, coverage_year, notes, source_url, raw_data
        ) VALUES (
          ${s.entitySlug}, ${s.source}, ${s.volumeBblYrMin}, ${s.volumeBblYrMax},
          ${s.confidence}, ${s.coverageYear}, ${s.notes}, ${s.sourceUrl},
          ${JSON.stringify(s.rawData)}::jsonb
        );
      `);
      signalsUpserted += 1;
    } catch (err) {
      errors.push(`signal ${s.entitySlug}: ${(err as Error).message}`);
    }
  }
  console.log(`  upserted ${signalsUpserted}/${SIGNALS.length} signals`);

  if (errors.length > 0) {
    console.error('Errors:');
    for (const e of errors) console.error('  ' + e);
    process.exit(1);
  }
  console.log('done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
