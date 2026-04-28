/**
 * EIA daily refined-product price ingest — US Gulf Coast diesel +
 * gasoline + NY Harbor heating oil.
 *
 * Source: https://api.eia.gov/v2/  (US Energy Information Administration)
 * Free API key required: set EIA_API_KEY in .env.local. Sign up at
 *   https://www.eia.gov/opendata/register.php
 *
 * Without EIA_API_KEY this script no-ops with a warning — the FRED
 * ingest covers Brent + WTI without auth, so the user can still get
 * crude price context immediately.
 *
 * EIA returns prices in USD/gallon for refined products and USD/bbl
 * for crude. We store unit verbatim so downstream callers convert
 * explicitly.
 *
 * Run: pnpm --filter @procur/db ingest-eia-prices
 *      pnpm --filter @procur/db ingest-eia-prices --since=2020-01-01
 */
import 'dotenv/config';
import { config as loadEnv } from 'dotenv';
import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import { sql } from 'drizzle-orm';
import * as schema from './schema';

loadEnv({ path: '../../.env.local' });
loadEnv({ path: '../../.env' });

const EIA_BASE = 'https://api.eia.gov/v2/petroleum/pri/spt/data';

type EiaSeries = {
  slug: string;
  /** EIA product code: 'EPD2DXL0' (ULSD), 'EPMRU' (RBOB gasoline), etc. */
  product: string;
  /** EIA duoarea: 'Y35NY' (NY Harbor), 'PF4_RGC' (Gulf Coast). */
  duoarea: string;
  unit: string;
  label: string;
};

/**
 * EIA spot-price series we ingest.
 *
 * Slugs are kept generic ('diesel-spot', 'gasoline-spot') so future
 * regional sources (Gulf Coast, LA, Singapore) can extend without
 * touching the benchmark mapping table. Currently all three are NY
 * Harbor — the most-published spot location and a defensible proxy
 * for Caribbean / east-coast US delivery.
 *
 * USGC duoarea codes the EIA v2 API exposes are non-obvious from the
 * docs (Y05/RGC/PA3 all return 0 rows in different combinations).
 * Tracking USGC-specific series as a follow-up; NY Harbor + a basis
 * adjustment in commodity_benchmark_mappings is the v1 stand-in.
 */
const SERIES: EiaSeries[] = [
  {
    slug: 'nyh-diesel',
    product: 'EPD2DXL0',
    duoarea: 'Y35NY',
    unit: 'usd-gal',
    label: 'NY Harbor ULSD diesel',
  },
  {
    slug: 'nyh-gasoline',
    // EPMRU = Reformulated Regular RBOB; this is the actively-traded
    // NY Harbor gasoline contract (Northeast US uses RFG mandated by
    // CAA, so reformulated is the live spot, not conventional EPMRR).
    product: 'EPMRU',
    duoarea: 'Y35NY',
    unit: 'usd-gal',
    label: 'NY Harbor RBOB gasoline (reformulated)',
  },
  {
    slug: 'nyh-heating-oil',
    product: 'EPD2F',
    duoarea: 'Y35NY',
    unit: 'usd-gal',
    label: 'NY Harbor heating oil',
  },
];

type EiaResponse = {
  response?: {
    data?: Array<{
      period: string;
      product: string;
      'duoarea': string;
      value: number | string | null;
    }>;
    total?: number;
  };
};

async function fetchSeries(
  apiKey: string,
  series: EiaSeries,
  since: string,
): Promise<Array<{ priceDate: string; price: number }>> {
  const params = new URLSearchParams({
    api_key: apiKey,
    frequency: 'daily',
    'data[0]': 'value',
    'facets[product][]': series.product,
    'facets[duoarea][]': series.duoarea,
    start: since,
    // EIA v2 expects nested sort: sort[0][column]=...&sort[0][direction]=...
    'sort[0][column]': 'period',
    'sort[0][direction]': 'asc',
    length: '5000',
  });
  const url = `${EIA_BASE}?${params}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'procur-research/1.0 (cole@vectortradecapital.com)' },
  });
  if (!res.ok) throw new Error(`EIA ${res.status} for ${series.slug}: ${await res.text()}`);
  const json = (await res.json()) as EiaResponse;
  const rows = json.response?.data ?? [];
  return rows
    .filter((r) => r.value != null)
    .map((r) => ({
      priceDate: r.period,
      price: typeof r.value === 'number' ? r.value : Number.parseFloat(String(r.value)),
    }))
    .filter((r) => Number.isFinite(r.price));
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set');

  const apiKey = process.env.EIA_API_KEY;
  if (!apiKey) {
    console.warn(
      'EIA_API_KEY not set — skipping refined-product ingest. Sign up at ' +
        'https://www.eia.gov/opendata/register.php and add the key to .env.local.',
    );
    return;
  }

  const sinceArg = process.argv.find((a) => a.startsWith('--since='))?.split('=')[1];
  const sinceDate = sinceArg ?? '2022-01-01';

  const client = neon(url);
  const db = drizzle(client, { schema, casing: 'snake_case' });

  for (const series of SERIES) {
    console.log(`Fetching ${series.label}...`);
    const rows = await fetchSeries(apiKey, series, sinceDate);
    console.log(`  ${rows.length} rows since ${sinceDate}. Upserting...`);
    if (rows.length === 0) continue;

    let upserted = 0;
    const chunkSize = 500;
    for (let i = 0; i < rows.length; i += chunkSize) {
      const chunk = rows.slice(i, i + chunkSize);
      const values = chunk.map((r) => ({
        seriesSlug: series.slug,
        contractType: 'spot',
        source: 'eia',
        priceDate: r.priceDate,
        price: String(r.price),
        unit: series.unit,
        metadata: { eia_product: series.product, eia_duoarea: series.duoarea },
      }));
      const res = await db
        .insert(schema.commodityPrices)
        .values(values)
        .onConflictDoUpdate({
          target: [
            schema.commodityPrices.seriesSlug,
            schema.commodityPrices.contractType,
            schema.commodityPrices.priceDate,
          ],
          set: {
            price: sql`excluded.price`,
            source: sql`excluded.source`,
            unit: sql`excluded.unit`,
            metadata: sql`excluded.metadata`,
          },
        })
        .returning({ id: schema.commodityPrices.id });
      upserted += res.length;
    }
    console.log(`  ${series.label}: ${upserted} rows upserted.`);
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
