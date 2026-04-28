/**
 * UN Comtrade ingest — global monthly trade flows.
 *
 * Source: UN Comtrade public preview API (free, no key required for
 * ≤100 calls/hour).
 *   Base: https://comtradeapi.un.org/public/v1/preview/{type}/{freq}/{class}
 *   Format: JSON array of records
 *
 * What this complements vs the Eurostat ingest:
 *   - Eurostat: EU reporters only, monthly, EUR-denominated
 *   - UN Comtrade: GLOBAL reporters, monthly, USD-denominated (no FX
 *     conversion needed), lagged ~3 months
 *
 * For the active Libyan crude deal, this surfaces Asian + African +
 * Middle Eastern importers (IOCL India, Sinopec China, Pertamina,
 * Pakistan PSO, Bangladesh BPC) that Eurostat doesn't see.
 *
 * Public preview limit: 100 records per call. We chunk by single
 * (period, partner, product) tuple to stay under it — that returns
 * one row per reporter (~50 reporters per cargo flow), comfortably
 * under the limit.
 *
 * Idempotent on (source, reporter, partner, product, flow, period).
 *
 * Run from repo root:
 *   pnpm --filter @procur/db ingest-un-comtrade
 *
 * Env overrides:
 *   COMTRADE_PRODUCT=2709           # HS code, default crude petroleum
 *   COMTRADE_PARTNER_M49=434        # M49 numeric, default Libya
 *   COMTRADE_LOOKBACK_MONTHS=24
 *   COMTRADE_API_KEY=...            # optional: paid tier for higher limits
 *
 * Docs: https://comtradeapi.un.org/files/v1/app/reference/CTAPI%20Reference%20guide.pdf
 */
import 'dotenv/config';
import { config as loadEnv } from 'dotenv';
import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import * as schema from './schema';
import { m49ToIso2 } from './lib/country-codes';

loadEnv({ path: '../../.env.local' });
loadEnv({ path: '../../.env' });

const COMTRADE_BASE = 'https://comtradeapi.un.org/public/v1/preview';

type ComtradeRecord = {
  typeCode: string;
  freqCode: string;
  refPeriodId?: number;
  refYear: number;
  refMonth?: number;
  reporterCode: number;
  reporterISO?: string;
  reporterDesc?: string;
  partnerCode: number;
  partnerISO?: string;
  partnerDesc?: string;
  cmdCode: string;
  flowCode: string;
  qty?: number | null;
  qtyUnitCode?: number | null;
  netWgt?: number | null;
  primaryValue?: number | null;
  cifvalue?: number | null;
  fobvalue?: number | null;
};

type ComtradeResponse = {
  count?: number;
  data?: ComtradeRecord[];
  error?: string;
};

type Args = {
  product: string;
  partnerM49: string;
  lookbackMonths: number;
  apiKey?: string;
};

function buildPeriods(monthsLookback: number): string[] {
  // UN Comtrade monthly period format: YYYYMM (e.g. 202406).
  // Skip the most recent 4 months — UN Comtrade lag varies by reporter
  // but typically 3-4 months. Querying empty periods returns 400 from
  // the preview API.
  const periods: string[] = [];
  const now = new Date();
  for (let i = 4; i < monthsLookback + 4; i += 1) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    periods.push(`${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  return periods;
}

/**
 * Curated list of M49 reporter codes covering the global trade flows
 * VTC tracks. The public preview API rejects reporterCode=all (returns
 * 400); we enumerate explicit codes instead. Comma-separated up to ~40
 * fits in a single URL and stays under the 100-record-per-call preview
 * limit per period.
 */
const REPORTER_M49_LIST = [
  // Europe (EU + EFTA + UK + Turkey)
  '040', '056', '100', '191', '196', '203', '208', '233', '246', '250',
  '276', '300', '348', '372', '380', '428', '440', '442', '470', '528',
  '578', '616', '620', '642', '688', '703', '705', '724', '752', '756',
  '792', '826',
  // Asia
  '050', '156', '356', '360', '392', '410', '458', '586', '702', '764',
  '784', '704',
  // Americas
  '076', '124', '152', '170', '484', '604', '780', '840',
  // Africa + ME
  '012', '231', '364', '368', '414', '566', '634', '682', '710', '818',
  // Oceania
  '036',
];

async function fetchOnePeriod(
  period: string,
  args: Args,
): Promise<ComtradeRecord[]> {
  const params = new URLSearchParams({
    cmdCode: args.product,
    flowCode: 'M', // imports
    partnerCode: args.partnerM49,
    period,
    reporterCode: REPORTER_M49_LIST.join(','),
  });
  const url = `${COMTRADE_BASE}/C/M/HS?${params.toString()}`;
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'User-Agent': 'procur-research/1.0',
  };
  if (args.apiKey) headers['Ocp-Apim-Subscription-Key'] = args.apiKey;

  const res = await fetch(url, { headers });
  if (!res.ok) {
    if (res.status === 429) {
      // Rate-limited — wait + retry once.
      await new Promise((r) => setTimeout(r, 60_000));
      const retry = await fetch(url, { headers });
      if (!retry.ok) {
        throw new Error(`UN Comtrade ${retry.status} after retry: ${url}`);
      }
      return ((await retry.json()) as ComtradeResponse).data ?? [];
    }
    throw new Error(`UN Comtrade ${res.status}: ${url}`);
  }
  const json = (await res.json()) as ComtradeResponse;
  if (json.error) throw new Error(`UN Comtrade error: ${json.error}`);
  return json.data ?? [];
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set');

  const args: Args = {
    product: process.env.COMTRADE_PRODUCT ?? '2709',
    partnerM49: process.env.COMTRADE_PARTNER_M49 ?? '434', // Libya
    lookbackMonths: Number.parseInt(process.env.COMTRADE_LOOKBACK_MONTHS ?? '24', 10),
    apiKey: process.env.COMTRADE_API_KEY,
  };
  console.log('UN Comtrade ingest', args);

  const partnerIso2 = m49ToIso2(args.partnerM49) ?? args.partnerM49;
  const periods = buildPeriods(args.lookbackMonths);
  console.log(`  fetching ${periods.length} monthly periods (~3-month lag)`);

  const client = neon(url);
  const db = drizzle(client, { schema, casing: 'snake_case' });

  let totalRecords = 0;
  let upserted = 0;
  let unmappedReporters = new Set<string>();

  for (const period of periods) {
    let records: ComtradeRecord[];
    try {
      records = await fetchOnePeriod(period, args);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`  ${period}: fetch failed (${msg}) — skipping`);
      continue;
    }
    totalRecords += records.length;
    if (records.length === 0) {
      console.log(`  ${period}: no data`);
      continue;
    }

    for (const r of records) {
      const reporterIso2 = m49ToIso2(r.reporterCode);
      if (!reporterIso2) {
        unmappedReporters.add(`${r.reporterCode}:${r.reporterDesc ?? ''}`);
        continue;
      }
      // Sanity: skip aggregate / placeholder reporters.
      if (reporterIso2 === '00') continue;

      const periodIso = `${String(r.refYear).padStart(4, '0')}-${String(
        r.refMonth ?? 1,
      ).padStart(2, '0')}-01`;

      const valueUsd = r.primaryValue ?? r.cifvalue ?? r.fobvalue ?? null;
      const quantityKg = r.netWgt ?? null;

      await db
        .insert(schema.customsImports)
        .values({
          source: 'un-comtrade',
          reporterCountry: reporterIso2,
          partnerCountry: partnerIso2,
          productCode: args.product,
          productLabel: null,
          flowDirection: 'import',
          period: periodIso,
          periodGranularity: 'M',
          quantityKg: quantityKg != null ? String(quantityKg) : null,
          // UN Comtrade publishes USD directly — store as both native and USD.
          valueNative: valueUsd != null ? String(valueUsd) : null,
          valueCurrency: 'USD',
          valueUsd: valueUsd != null ? String(valueUsd) : null,
          rawPayload: {
            reporterDesc: r.reporterDesc,
            partnerDesc: r.partnerDesc,
            qty: r.qty,
            qtyUnitCode: r.qtyUnitCode,
            cifvalue: r.cifvalue,
            fobvalue: r.fobvalue,
          },
        })
        .onConflictDoUpdate({
          target: [
            schema.customsImports.source,
            schema.customsImports.reporterCountry,
            schema.customsImports.partnerCountry,
            schema.customsImports.productCode,
            schema.customsImports.flowDirection,
            schema.customsImports.period,
          ],
          set: {
            quantityKg: quantityKg != null ? String(quantityKg) : null,
            valueNative: valueUsd != null ? String(valueUsd) : null,
            valueUsd: valueUsd != null ? String(valueUsd) : null,
            updatedAt: new Date(),
          },
        });
      upserted += 1;
    }
    console.log(`  ${period}: ${records.length} records`);
    // Polite delay between calls — public preview is gentle but not infinite.
    await new Promise((r) => setTimeout(r, 500));
  }

  console.log(
    `Done. periods=${periods.length}, totalRecords=${totalRecords}, upserted=${upserted}`,
  );
  if (unmappedReporters.size > 0) {
    console.warn(
      `  ${unmappedReporters.size} unmapped reporters (extend M49_TO_ISO2 in lib/country-codes.ts):`,
    );
    for (const r of unmappedReporters) console.warn(`    ${r}`);
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
