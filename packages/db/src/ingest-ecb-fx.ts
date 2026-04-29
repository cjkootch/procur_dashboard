/**
 * ECB historical FX ingest — daily reference rates against EUR.
 *
 * Source: https://data-api.ecb.europa.eu/  (free, no key required)
 * Going back to 1999. The ECB publishes "EUR per 1 unit of USD/JPY/etc."
 * as their reference series; we cross-multiply to get our convention
 * (USD per 1 unit of currency_code).
 *
 * Endpoint pattern:
 *   /service/data/EXR/D.<CCY>.EUR.SP00.A?format=csvdata
 * E.g. for USD: D.USD.EUR.SP00.A → daily USD-per-EUR.
 *
 * Conversion identity: if 1 EUR = X USD and 1 EUR = Y JPY, then
 *   1 JPY = (X / Y) USD
 * We anchor every series via EUR↔USD daily, then cross-multiply each
 * other currency.
 *
 * Coverage: ~33 currencies that ECB publishes against EUR. Sufficient
 * for the country-default-currencies seed. For currencies outside ECB
 * (e.g. some West African + Caribbean currencies that are USD-pegged
 * or USD-priced anyway), the country_default_currencies seed routes
 * those countries to USD — no FX lookup needed.
 *
 * Run: pnpm --filter @procur/db ingest-ecb-fx
 *      pnpm --filter @procur/db ingest-ecb-fx --since=2020-01-01
 */
import 'dotenv/config';
import { config as loadEnv } from 'dotenv';
import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import { sql } from 'drizzle-orm';
import * as schema from './schema';

loadEnv({ path: '../../.env.local' });
loadEnv({ path: '../../.env' });

const ECB_BASE = 'https://data-api.ecb.europa.eu/service/data/EXR';

/** Currencies ECB publishes daily reference rates for (against EUR). */
const ECB_CURRENCIES = [
  'USD',
  'JPY',
  'BGN',
  'CZK',
  'DKK',
  'GBP',
  'HUF',
  'PLN',
  'RON',
  'SEK',
  'CHF',
  'ISK',
  'NOK',
  'TRY',
  'AUD',
  'BRL',
  'CAD',
  'CNY',
  'HKD',
  'IDR',
  'ILS',
  'INR',
  'KRW',
  'MXN',
  'MYR',
  'NZD',
  'PHP',
  'SGD',
  'THB',
  'ZAR',
];

type EcbRow = {
  rateDate: string;
  /** EUR per 1 unit of currency. ECB convention. */
  eurPerUnit: number;
};

async function fetchSeries(currency: string, since: string): Promise<EcbRow[]> {
  const url = `${ECB_BASE}/D.${currency}.EUR.SP00.A?format=csvdata&startPeriod=${since}`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'procur-research/1.0 (cole@vectortradecapital.com)',
      Accept: 'text/csv',
    },
  });
  if (!res.ok) {
    if (res.status === 404) {
      console.warn(`  ECB has no series for ${currency} — skipping.`);
      return [];
    }
    throw new Error(`ECB ${res.status} for ${currency}: ${(await res.text()).slice(0, 300)}`);
  }
  const csv = await res.text();
  const lines = csv.split(/\r?\n/);
  if (lines.length < 2) return [];
  const header = lines[0]!.split(',');
  const dateIdx = header.indexOf('TIME_PERIOD');
  const valueIdx = header.indexOf('OBS_VALUE');
  if (dateIdx < 0 || valueIdx < 0) return [];
  const out: EcbRow[] = [];
  for (let i = 1; i < lines.length; i += 1) {
    const cells = lines[i]!.split(',');
    const d = cells[dateIdx];
    const v = cells[valueIdx];
    if (!d || !v) continue;
    const n = Number.parseFloat(v);
    if (!Number.isFinite(n) || n <= 0) continue;
    out.push({ rateDate: d, eurPerUnit: n });
  }
  return out;
}

export type IngestEcbFxResult = {
  since: string;
  totalRowsUpserted: number;
  perCurrency: Record<string, number>;
  skippedCurrencies: string[];
};

/**
 * Ingest ECB daily FX rates. Pure function — caller owns env loading
 * (DATABASE_URL must be set). Used by both the CLI shim below and the
 * Trigger.dev scheduled task in services/scrapers.
 */
export async function ingestEcbFx(opts: {
  /** YYYY-MM-DD. Default 2020-01-01 for backfill, or a recent date for cron. */
  since?: string;
} = {}): Promise<IngestEcbFxResult> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set');

  const sinceDate = opts.since ?? '2020-01-01';
  const client = neon(url);
  const db = drizzle(client, { schema, casing: 'snake_case' });

  const perCurrency: Record<string, number> = {};
  const skippedCurrencies: string[] = [];
  let totalRowsUpserted = 0;

  // 1. Pull EUR↔USD daily — the anchor for cross-multiplication.
  const usdRows = await fetchSeries('USD', sinceDate);
  if (usdRows.length === 0) throw new Error('ECB returned no USD rows');

  // Index date → USD-per-EUR for cross-mult.
  const usdPerEurByDate = new Map<string, number>();
  for (const r of usdRows) usdPerEurByDate.set(r.rateDate, r.eurPerUnit);

  // 2. Write EUR rate (1 EUR = N USD) directly.
  const eurValues = usdRows.map((r) => ({
    currencyCode: 'EUR',
    rateDate: r.rateDate,
    rateToUsd: String(r.eurPerUnit),
    source: 'ecb',
  }));
  await upsertChunk(db, eurValues);
  perCurrency.EUR = eurValues.length;
  totalRowsUpserted += eurValues.length;

  // 3. Write USD rate (always 1).
  const usdValues = usdRows.map((r) => ({
    currencyCode: 'USD',
    rateDate: r.rateDate,
    rateToUsd: '1',
    source: 'ecb',
  }));
  await upsertChunk(db, usdValues);
  perCurrency.USD = usdValues.length;
  totalRowsUpserted += usdValues.length;

  // 4. For every other currency, fetch its EUR series + cross-multiply.
  for (const currency of ECB_CURRENCIES) {
    if (currency === 'USD') continue;
    const rows = await fetchSeries(currency, sinceDate);
    if (rows.length === 0) {
      skippedCurrencies.push(currency);
      continue;
    }
    const values: Array<{
      currencyCode: string;
      rateDate: string;
      rateToUsd: string;
      source: string;
    }> = [];
    for (const r of rows) {
      const usdPerEur = usdPerEurByDate.get(r.rateDate);
      if (usdPerEur == null) continue;
      // 1 EUR = r.eurPerUnit <currency>  →  1 <currency> = 1 / r.eurPerUnit EUR
      // 1 EUR = usdPerEur USD             →  1 <currency> = usdPerEur / r.eurPerUnit USD
      const rateToUsd = usdPerEur / r.eurPerUnit;
      if (!Number.isFinite(rateToUsd) || rateToUsd <= 0) continue;
      values.push({
        currencyCode: currency,
        rateDate: r.rateDate,
        rateToUsd: rateToUsd.toFixed(8),
        source: 'ecb',
      });
    }
    if (values.length === 0) {
      skippedCurrencies.push(currency);
      continue;
    }
    await upsertChunk(db, values);
    perCurrency[currency] = values.length;
    totalRowsUpserted += values.length;
    // Be polite to the ECB API.
    await new Promise((r) => setTimeout(r, 250));
  }

  return { since: sinceDate, totalRowsUpserted, perCurrency, skippedCurrencies };
}

async function main() {
  const sinceArg = process.argv.find((a) => a.startsWith('--since='))?.split('=')[1];
  console.log('Fetching EUR↔USD anchor + cross-rates from ECB...');
  const result = await ingestEcbFx({ since: sinceArg });
  console.log(
    `Done. ${result.totalRowsUpserted} rows upserted across ` +
      `${Object.keys(result.perCurrency).length} currencies since ${result.since}.`,
  );
  if (result.skippedCurrencies.length > 0) {
    console.log(`Skipped (no data): ${result.skippedCurrencies.join(', ')}`);
  }
}

async function upsertChunk(
  db: ReturnType<typeof drizzle<typeof schema>>,
  values: Array<{
    currencyCode: string;
    rateDate: string;
    rateToUsd: string;
    source: string;
  }>,
): Promise<void> {
  const chunkSize = 500;
  for (let i = 0; i < values.length; i += chunkSize) {
    const chunk = values.slice(i, i + chunkSize);
    await db
      .insert(schema.fxRates)
      .values(chunk)
      .onConflictDoUpdate({
        target: [schema.fxRates.currencyCode, schema.fxRates.rateDate],
        set: {
          rateToUsd: sql`excluded.rate_to_usd`,
          source: sql`excluded.source`,
          ingestedAt: new Date(),
        },
      });
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
