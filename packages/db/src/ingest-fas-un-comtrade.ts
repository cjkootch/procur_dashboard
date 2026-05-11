/**
 * FAS UN ComTrade ingest — annual HS6 trade flows for the
 * Caribbean / LATAM seed countries. Pulls imports + exports +
 * re-exports per reporter × year and writes to the existing
 * `customs_imports` table with source='fas-un-comtrade'.
 *
 * Source: https://api.fas.usda.gov/api/gats/UNTrade{Imports,Exports,ReExports}/...
 * Spec:   https://apps.fas.usda.gov/opendatawebV2/assets/swagger/swagger.json
 *
 * What this answers:
 *   "Across the last 5 years, who shipped what to Venezuela / Jamaica /
 *    Trinidad / etc. at HS6 granularity — including non-US trade lanes
 *    the bilateral US Census data doesn't capture."
 *
 * Idempotent on customs_imports unique index
 * (source, reporter, partner, product, flow_direction, period).
 *
 * Run from repo root:
 *   pnpm --filter @procur/db ingest-fas-un-comtrade
 *
 * Env:
 *   FAS_API_KEY                # required
 *   FAS_UNTRADE_YEARS=2021-2025  # default: 5 most recent
 *   FAS_UNTRADE_FLOWS=imports,exports,reexports   # default: imports + exports
 */
import 'dotenv/config';
import { config as loadEnv } from 'dotenv';
import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import { sql } from 'drizzle-orm';
import * as schema from './schema';
import {
  createFasClient,
  type FasCountryRecord,
  type FasUNTradeRecord,
} from './lib/fas-client';
import { FAS_SEED_COUNTRIES } from './lib/fas-seed-countries';

loadEnv({ path: '../../.env.local' });
loadEnv({ path: '../../.env' });

type Flow = 'imports' | 'exports' | 'reexports';

const FLOW_TO_ENDPOINT: Record<Flow, string> = {
  imports: 'UNTradeImports',
  exports: 'UNTradeExports',
  reexports: 'UNTradeReExports',
};

const FLOW_DIRECTION: Record<Flow, 'import' | 'export' | 're-export'> = {
  imports: 'import',
  exports: 'export',
  reexports: 're-export',
};

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required.');
  }
  const db = drizzle(neon(process.env.DATABASE_URL), { schema });
  const client = createFasClient();

  const years = parseYears(process.env.FAS_UNTRADE_YEARS, defaultYears());
  const flows = parseFlows(process.env.FAS_UNTRADE_FLOWS, ['imports', 'exports']);
  console.log(
    `[fas-un-comtrade] years=${years.join(',')} flows=${flows.join(',')}`,
  );

  // Cache + map FAS GATS country codes for the seed list.
  const gatsCountries = await client.get<FasCountryRecord[]>('/api/gats/countries');
  const gatsByCode = new Map(gatsCountries.map((c) => [c.countryCode, c]));
  const fasGatsToIso2 = new Map(
    FAS_SEED_COUNTRIES.map((c) => [c.gatsCode, c.iso2]),
  );

  let totalRows = 0;
  let skippedCountries = 0;

  for (const country of FAS_SEED_COUNTRIES) {
    if (!gatsByCode.has(country.gatsCode)) {
      console.warn(
        `[fas-un-comtrade] seed country ${country.iso2} (${country.name}) — GATS code "${country.gatsCode}" not in /gats/countries; skipping`,
      );
      skippedCountries += 1;
      continue;
    }
    for (const year of years) {
      for (const flow of flows) {
        try {
          const records = await client.get<FasUNTradeRecord[]>(
            `/api/gats/${FLOW_TO_ENDPOINT[flow]}/reporterCode/${country.gatsCode}/year/${year}`,
          );
          if (records.length === 0) continue;
          const rows = records
            .map((r) =>
              buildCustomsImportRow(
                r,
                country.iso2,
                fasGatsToIso2,
                FLOW_DIRECTION[flow],
                year,
              ),
            )
            .filter((r): r is schema.NewCustomsImport => r != null);
          if (rows.length > 0) {
            await upsertCustomsBatch(db, rows);
          }
          totalRows += rows.length;
          console.log(
            `[fas-un-comtrade] ${country.iso2} ${flow} ${year}: ${rows.length}/${records.length} rows`,
          );
        } catch (err) {
          console.warn(
            `[fas-un-comtrade] ${country.iso2} ${flow} ${year} failed:`,
            err instanceof Error ? err.message : err,
          );
        }
      }
    }
  }

  console.log(
    `[fas-un-comtrade] done. rows=${totalRows} skipped_countries=${skippedCountries}`,
  );
}

function defaultYears(): number[] {
  const now = new Date();
  // UN ComTrade lags ~6-12 months; the last calendar year may be
  // partial. Default to the 5 most recent (current excluded).
  const latest = now.getFullYear() - 1;
  return [latest, latest - 1, latest - 2, latest - 3, latest - 4];
}

function parseYears(raw: string | undefined, fallback: number[]): number[] {
  if (!raw) return fallback;
  if (raw.includes('-')) {
    const parts = raw.split('-').map((s) => Number.parseInt(s.trim(), 10));
    const a = parts[0];
    const b = parts[1];
    if (a != null && b != null && Number.isFinite(a) && Number.isFinite(b)) {
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      const ys: number[] = [];
      for (let y = lo; y <= hi; y++) ys.push(y);
      return ys;
    }
  }
  return raw
    .split(',')
    .map((s) => Number.parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n) && n > 1900 && n < 2100);
}

function parseFlows(raw: string | undefined, fallback: Flow[]): Flow[] {
  if (!raw) return fallback;
  const ok = (s: string): s is Flow =>
    s === 'imports' || s === 'exports' || s === 'reexports';
  return raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(ok);
}

function buildCustomsImportRow(
  r: FasUNTradeRecord,
  reporterIso2: string,
  partnerMap: Map<string, string>,
  flowDirection: 'import' | 'export' | 're-export',
  year: number,
): schema.NewCustomsImport | null {
  if (!r.hsCode) return null;
  // Resolve partner FAS code → ISO-2 when we have a mapping; fall
  // back to the FAS code verbatim so the row still lands (caller
  // can backfill ISO-2 later from fas_countries).
  const partnerCountry = partnerMap.get(r.partnerCode) ?? r.partnerCode;
  return {
    source: 'fas-un-comtrade',
    reporterCountry: reporterIso2,
    partnerCountry,
    productCode: r.hsCode,
    productLabel: null,
    flowDirection,
    period: `${year}-01-01`,
    periodGranularity: 'Y',
    quantityKg:
      r.netWeightKg != null && Number.isFinite(r.netWeightKg)
        ? String(r.netWeightKg)
        : null,
    valueNative:
      r.value != null && Number.isFinite(r.value) ? String(r.value) : null,
    valueCurrency: 'USD',
    valueUsd:
      r.value != null && Number.isFinite(r.value) ? String(r.value) : null,
    rawPayload: r as unknown as Record<string, unknown>,
  };
}

async function upsertCustomsBatch(
  db: ReturnType<typeof drizzle<typeof schema>>,
  rows: schema.NewCustomsImport[],
) {
  if (rows.length === 0) return;
  // Insert in chunks to keep individual statements reasonably sized
  // (UN ComTrade returns up to ~thousands of HS6 lines per reporter
  // × year).
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK);
    await db
      .insert(schema.customsImports)
      .values(slice)
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
          quantityKg: sql`EXCLUDED.quantity_kg`,
          valueNative: sql`EXCLUDED.value_native`,
          valueUsd: sql`EXCLUDED.value_usd`,
          rawPayload: sql`EXCLUDED.raw_payload`,
          updatedAt: sql`NOW()`,
        },
      });
  }
}

main().catch((err) => {
  console.error('[fas-un-comtrade] FAILED', err);
  process.exit(1);
});
