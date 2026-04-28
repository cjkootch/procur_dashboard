/**
 * Seed commodity_benchmark_mappings — the lookup that resolves
 * (category × country × grade) to a concrete commodity_prices.series_slug.
 *
 * Slugs MUST match what the FRED + EIA ingests already write into
 * commodity_prices. Refer to ingest-fred-prices.ts and
 * ingest-eia-prices.ts for the canonical set:
 *   - 'brent', 'wti'                    (FRED, USD/bbl)
 *   - 'nyh-diesel', 'nyh-gasoline',
 *     'nyh-heating-oil'                  (EIA, USD/gal)
 *
 * Phase 2 (the materialized-view build) handles the unit conversion
 * USD/gal → USD/bbl when refined-product mappings are joined to
 * award per-bbl prices. For now this seed just stages the mappings.
 *
 * Adjustment column (benchmark_adjustment_usd_bbl) bakes in known
 * stable spreads — e.g. RBOB 87 vs 93 has ~$8/bbl premium for the
 * higher-octane grade. Refined as the empirical distribution emerges.
 *
 * Idempotent (ON CONFLICT). Edit the rows + re-run to update.
 *
 * Run: pnpm --filter @procur/db seed-commodity-benchmarks
 */
import 'dotenv/config';
import { config as loadEnv } from 'dotenv';
import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import { sql } from 'drizzle-orm';
import * as schema from './schema';

loadEnv({ path: '../../.env.local' });
loadEnv({ path: '../../.env' });

type BenchmarkSeed = {
  category: string;
  country: string;
  grade: string | null;
  benchmarkSlug: string;
  benchmarkSource: 'fred' | 'eia';
  adjustmentUsdBbl?: number;
  notes?: string;
};

const SEEDS: BenchmarkSeed[] = [
  // ── Diesel ─────────────────────────────────────────────────
  // Default global benchmark = NY Harbor ULSD (EIA nyh-diesel is GC,
  // close enough; we accept the regional basis difference for v1).
  {
    category: 'diesel',
    country: 'GLOBAL',
    grade: 'ulsd_50ppm',
    benchmarkSlug: 'nyh-diesel',
    benchmarkSource: 'eia',
    notes: 'NY Harbor ULSD as global default',
  },
  {
    category: 'diesel',
    country: 'GLOBAL',
    grade: 'ulsd_500ppm',
    benchmarkSlug: 'nyh-diesel',
    benchmarkSource: 'eia',
    adjustmentUsdBbl: -3.5,
    notes: 'No 2 distillate / 500 ppm trades ~$3.50/bbl below ULSD',
  },
  // Caribbean diesel — default to USGC ULSD (regional supply)
  { category: 'diesel', country: 'DO', grade: null, benchmarkSlug: 'nyh-diesel', benchmarkSource: 'eia' },
  { category: 'diesel', country: 'JM', grade: null, benchmarkSlug: 'nyh-diesel', benchmarkSource: 'eia' },
  { category: 'diesel', country: 'TT', grade: null, benchmarkSlug: 'nyh-diesel', benchmarkSource: 'eia' },
  { category: 'diesel', country: 'BS', grade: null, benchmarkSlug: 'nyh-diesel', benchmarkSource: 'eia' },
  { category: 'diesel', country: 'BB', grade: null, benchmarkSlug: 'nyh-diesel', benchmarkSource: 'eia' },
  { category: 'diesel', country: 'HT', grade: null, benchmarkSlug: 'nyh-diesel', benchmarkSource: 'eia' },
  { category: 'diesel', country: 'PR', grade: null, benchmarkSlug: 'nyh-diesel', benchmarkSource: 'eia' },
  // LatAm diesel
  { category: 'diesel', country: 'MX', grade: null, benchmarkSlug: 'nyh-diesel', benchmarkSource: 'eia' },
  { category: 'diesel', country: 'CO', grade: null, benchmarkSlug: 'nyh-diesel', benchmarkSource: 'eia' },
  { category: 'diesel', country: 'EC', grade: null, benchmarkSlug: 'nyh-diesel', benchmarkSource: 'eia' },
  { category: 'diesel', country: 'PE', grade: null, benchmarkSlug: 'nyh-diesel', benchmarkSource: 'eia' },
  { category: 'diesel', country: 'BR', grade: null, benchmarkSlug: 'nyh-diesel', benchmarkSource: 'eia' },
  // Mediterranean diesel — small premium for transatlantic + EU spec
  {
    category: 'diesel',
    country: 'IT',
    grade: null,
    benchmarkSlug: 'nyh-diesel',
    benchmarkSource: 'eia',
    adjustmentUsdBbl: 2,
    notes: 'Italian diesel — small premium for transatlantic shipping & EU spec',
  },
  {
    category: 'diesel',
    country: 'ES',
    grade: null,
    benchmarkSlug: 'nyh-diesel',
    benchmarkSource: 'eia',
    adjustmentUsdBbl: 2,
  },
  {
    category: 'diesel',
    country: 'GR',
    grade: null,
    benchmarkSlug: 'nyh-diesel',
    benchmarkSource: 'eia',
    adjustmentUsdBbl: 2,
  },
  // Indian diesel — slight discount, regional supply
  {
    category: 'diesel',
    country: 'IN',
    grade: null,
    benchmarkSlug: 'nyh-diesel',
    benchmarkSource: 'eia',
    adjustmentUsdBbl: -1,
  },
  // US diesel — direct
  { category: 'diesel', country: 'US', grade: null, benchmarkSlug: 'nyh-diesel', benchmarkSource: 'eia' },

  // ── Gasoline ───────────────────────────────────────────────
  {
    category: 'gasoline',
    country: 'GLOBAL',
    grade: 'rbob_87',
    benchmarkSlug: 'nyh-gasoline',
    benchmarkSource: 'eia',
    notes: 'NY Harbor conventional RBOB regular as global default',
  },
  {
    category: 'gasoline',
    country: 'GLOBAL',
    grade: 'rbob_93',
    benchmarkSlug: 'nyh-gasoline',
    benchmarkSource: 'eia',
    adjustmentUsdBbl: 8,
    notes: 'Premium 93-octane premium ~$8/bbl over regular',
  },
  { category: 'gasoline', country: 'DO', grade: null, benchmarkSlug: 'nyh-gasoline', benchmarkSource: 'eia' },
  { category: 'gasoline', country: 'JM', grade: null, benchmarkSlug: 'nyh-gasoline', benchmarkSource: 'eia' },
  { category: 'gasoline', country: 'TT', grade: null, benchmarkSlug: 'nyh-gasoline', benchmarkSource: 'eia' },
  { category: 'gasoline', country: 'BS', grade: null, benchmarkSlug: 'nyh-gasoline', benchmarkSource: 'eia' },
  { category: 'gasoline', country: 'HT', grade: null, benchmarkSlug: 'nyh-gasoline', benchmarkSource: 'eia' },
  { category: 'gasoline', country: 'US', grade: null, benchmarkSlug: 'nyh-gasoline', benchmarkSource: 'eia' },
  { category: 'gasoline', country: 'MX', grade: null, benchmarkSlug: 'nyh-gasoline', benchmarkSource: 'eia' },

  // ── Heating oil / No. 2 distillate ─────────────────────────
  {
    category: 'heating-oil',
    country: 'GLOBAL',
    grade: null,
    benchmarkSlug: 'nyh-heating-oil',
    benchmarkSource: 'eia',
    notes: 'NY Harbor No 2 heating oil',
  },

  // ── Crude oil ──────────────────────────────────────────────
  {
    category: 'crude-oil',
    country: 'GLOBAL',
    grade: null,
    benchmarkSlug: 'brent',
    benchmarkSource: 'fred',
    notes: 'Brent Europe spot — global default for crude',
  },
  {
    category: 'crude-oil',
    country: 'US',
    grade: null,
    benchmarkSlug: 'wti',
    benchmarkSource: 'fred',
    notes: 'WTI Cushing for US-domestic crude awards',
  },
  {
    category: 'crude-oil',
    country: 'CA',
    grade: null,
    benchmarkSlug: 'wti',
    benchmarkSource: 'fred',
    notes: 'WTI as proxy for Canadian-export crude',
  },
];

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set');

  const client = neon(url);
  const db = drizzle(client, { schema, casing: 'snake_case' });

  console.log(`Seeding ${SEEDS.length} commodity benchmark mappings...`);

  for (const s of SEEDS) {
    // ON CONFLICT keys = (category_tag, country_code, grade). NULL grade
    // is treated as a value via the unique index, so re-runs idempotent.
    await db.execute(sql`
      INSERT INTO commodity_benchmark_mappings
        (category_tag, country_code, grade, benchmark_slug, benchmark_source,
         benchmark_adjustment_usd_bbl, notes, updated_at)
      VALUES (
        ${s.category},
        ${s.country},
        ${s.grade},
        ${s.benchmarkSlug},
        ${s.benchmarkSource},
        ${s.adjustmentUsdBbl ?? null},
        ${s.notes ?? null},
        NOW()
      )
      ON CONFLICT (category_tag, country_code, grade) DO UPDATE SET
        benchmark_slug = EXCLUDED.benchmark_slug,
        benchmark_source = EXCLUDED.benchmark_source,
        benchmark_adjustment_usd_bbl = EXCLUDED.benchmark_adjustment_usd_bbl,
        notes = EXCLUDED.notes,
        updated_at = NOW();
    `);
  }
  console.log(`Done. ${SEEDS.length} mappings upserted.`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
