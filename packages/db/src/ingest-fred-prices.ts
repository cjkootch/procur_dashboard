/**
 * FRED daily commodity-price ingest — Brent + WTI.
 *
 * Source: https://fred.stlouisfed.org/ (St Louis Fed; CSV downloads).
 * License: free public-domain data. Cite "FRED, Federal Reserve Bank
 *   of St Louis" downstream.
 *
 * No API key required. Each series is fetched as a CSV via the
 * fredgraph endpoint and upserted into commodity_prices keyed on
 * (series_slug, contract_type='spot', price_date).
 *
 * FRED publishes "." as a sentinel for missing days (markets closed,
 * holiday, late update). We skip those rows — they get filled in on
 * subsequent runs as soon as FRED publishes a value.
 *
 * Run: pnpm --filter @procur/db ingest-fred-prices
 *      pnpm --filter @procur/db ingest-fred-prices --since=2020-01-01
 */
import 'dotenv/config';
import { config as loadEnv } from 'dotenv';
import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import { sql } from 'drizzle-orm';
import * as schema from './schema';

loadEnv({ path: '../../.env.local' });
loadEnv({ path: '../../.env' });

const FRED_BASE = 'https://fred.stlouisfed.org/graph/fredgraph.csv';

type FredSeries = {
  /** commodity_prices.series_slug to write under. */
  slug: string;
  /** FRED series id, e.g. DCOILBRENTEU. */
  fredId: string;
  /** Display name for logs. */
  label: string;
};

const SERIES: FredSeries[] = [
  { slug: 'brent', fredId: 'DCOILBRENTEU', label: 'Brent (Europe)' },
  { slug: 'wti', fredId: 'DCOILWTICO', label: 'WTI (Cushing OK)' },
];

async function fetchCsv(fredId: string): Promise<string> {
  const url = `${FRED_BASE}?id=${encodeURIComponent(fredId)}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'procur-research/1.0 (cole@vectortradecapital.com)' },
  });
  if (!res.ok) throw new Error(`FRED ${res.status} for ${fredId}: ${await res.text()}`);
  return res.text();
}

type Row = { priceDate: string; price: number };

function parseFredCsv(csv: string): Row[] {
  const lines = csv.split(/\r?\n/);
  const out: Row[] = [];
  // First line is header: DATE,<series_id>
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line) continue;
    const [d, v] = line.split(',');
    if (!d || !v) continue;
    if (v === '.') continue; // FRED sentinel for missing day
    const n = Number.parseFloat(v);
    if (!Number.isFinite(n)) continue;
    out.push({ priceDate: d, price: n });
  }
  return out;
}

export type IngestFredPricesResult = {
  since: string;
  perSeries: Record<string, number>;
  totalRowsUpserted: number;
};

/**
 * Pull FRED daily commodity prices (Brent + WTI) and upsert into
 * commodity_prices. CLI shim below; Trigger.dev cron wrapper in
 * services/scrapers/src/trigger/scheduled/ingest-fred-prices.ts.
 */
export async function ingestFredPrices(opts: {
  /** YYYY-MM-DD. Default 2020-01-01 for backfill, or a recent date
      for cron. */
  since?: string;
} = {}): Promise<IngestFredPricesResult> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set');
  const sinceDate = opts.since ?? '2020-01-01';

  const client = neon(url);
  const db = drizzle(client, { schema, casing: 'snake_case' });

  const perSeries: Record<string, number> = {};
  let totalRowsUpserted = 0;

  for (const series of SERIES) {
    const csv = await fetchCsv(series.fredId);
    const all = parseFredCsv(csv);
    const filtered = all.filter((r) => r.priceDate >= sinceDate);

    let inserted = 0;
    const chunkSize = 500;
    for (let i = 0; i < filtered.length; i += chunkSize) {
      const chunk = filtered.slice(i, i + chunkSize);
      const values = chunk.map((r) => ({
        seriesSlug: series.slug,
        contractType: 'spot',
        source: 'fred',
        priceDate: r.priceDate,
        price: String(r.price),
        unit: 'usd-bbl',
        metadata: { fred_id: series.fredId },
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
            metadata: sql`excluded.metadata`,
          },
        })
        .returning({ id: schema.commodityPrices.id });
      inserted += res.length;
    }
    perSeries[series.slug] = inserted;
    totalRowsUpserted += inserted;
  }

  return { since: sinceDate, perSeries, totalRowsUpserted };
}

async function main() {
  const sinceArg = process.argv.find((a) => a.startsWith('--since='))?.split('=')[1];
  console.log('FRED daily prices: fetching Brent + WTI...');
  const result = await ingestFredPrices({ since: sinceArg });
  console.log(
    `Done. ${result.totalRowsUpserted} rows upserted across ` +
      `${Object.keys(result.perSeries).length} series since ${result.since}.`,
  );
}

if (process.argv[1] && process.argv[1].endsWith('ingest-fred-prices.ts')) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
