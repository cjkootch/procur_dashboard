/**
 * FAS ESR (Export Sales Reporting) ingest — weekly US agricultural
 * export commitments + outstanding + accumulated sales by commodity
 * × destination country × marketing year.
 *
 * Source: https://api.fas.usda.gov/api/esr/exports/...
 * Spec:   https://apps.fas.usda.gov/opendatawebV2/assets/swagger/swagger.json
 *
 * What this answers:
 *   "Is the US currently shipping wheat / soybeans / corn / etc. to
 *    Venezuela / Jamaica / Dominican Republic / Trinidad / etc., and
 *    how much is in the pipeline?"
 *
 * Per the GAIN-extraction brief's Caribbean / LATAM seed list. Iterates
 * commodity × seed country × current+previous marketing years.
 *
 * Idempotent on (commodity_code, country_code, market_year, week_ending).
 * Re-running updates values + raw_payload.
 *
 * Run from repo root:
 *   pnpm --filter @procur/db ingest-fas-esr
 *
 * Env:
 *   FAS_API_KEY                 # required — signup at fas.usda.gov/data/open-data-portal
 *   FAS_ESR_MARKET_YEARS=2025,2024    # default: current + previous
 *   FAS_ESR_COMMODITIES=401,801,107   # default: all (fetched live)
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
  type FasEsrCommodityRecord,
  type FasEsrExportRecord,
} from './lib/fas-client';
import { FAS_SEED_COUNTRIES, resolveFasCountry } from './lib/fas-seed-countries';

loadEnv({ path: '../../.env.local' });
loadEnv({ path: '../../.env' });

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required.');
  }
  const db = drizzle(neon(process.env.DATABASE_URL), { schema });
  const client = createFasClient();

  const marketYears = parseMarketYears(
    process.env.FAS_ESR_MARKET_YEARS,
    defaultMarketYears(),
  );
  console.log(`[fas-esr] market years: ${marketYears.join(', ')}`);

  // Cache country reference for the audit trail + resolve each seed
  // country by NAME (FAS country code shapes vary across sub-APIs;
  // names are the stable join key). Log a sample of the API response
  // so a future code-name mismatch surfaces immediately.
  const countries = await client.get<FasCountryRecord[]>('/api/esr/countries');
  if (countries.length > 0) {
    const sample = countries[0];
    console.log(
      `[fas-esr] /esr/countries returned ${countries.length} rows. Sample keys: ${Object.keys(sample as object).join(',')}`,
    );
  }
  await upsertCountryReference(db, countries, 'esr');

  // Commodity scope: either operator-specified or all of FAS ESR's
  // commodity list. The list is short (~44) so "all" is fine.
  const allCommodities = await client.get<FasEsrCommodityRecord[]>(
    '/api/esr/commodities',
  );
  await upsertCommoditiesReference(db, allCommodities, 'esr');
  const commodityCodes = parseCommodityCodes(
    process.env.FAS_ESR_COMMODITIES,
    allCommodities.map((c) => c.commodityCode),
  );
  const commodityNames = new Map(
    allCommodities.map((c) => [c.commodityCode, c.commodityName]),
  );
  console.log(
    `[fas-esr] commodity codes: ${commodityCodes.length} (${commodityCodes.slice(0, 5).join(',')}...)`,
  );

  let totalRows = 0;
  let skippedCountries = 0;

  for (const country of FAS_SEED_COUNTRIES) {
    const resolved = resolveFasCountry(countries, country);
    if (!resolved) {
      console.warn(
        `[fas-esr] seed country ${country.iso2} (${country.name}) — no name match in /esr/countries; skipping`,
      );
      skippedCountries += 1;
      continue;
    }
    const fasCode = String(resolved.countryCode);
    for (const my of marketYears) {
      for (const commodityCode of commodityCodes) {
        try {
          const records = await client.get<FasEsrExportRecord[]>(
            `/api/esr/exports/commodityCode/${commodityCode}/countryCode/${fasCode}/marketYear/${my}`,
          );
          if (records.length === 0) continue;
          const rows = records.map((r) =>
            buildEsrRow(r, fasCode, commodityCode, my),
          );
          await upsertEsrBatch(db, rows);
          totalRows += records.length;
          console.log(
            `[fas-esr] ${country.iso2} ${commodityNames.get(commodityCode) ?? `cc=${commodityCode}`} MY${my}: ${records.length} weeks`,
          );
        } catch (err) {
          console.warn(
            `[fas-esr] ${country.iso2} cc=${commodityCode} MY${my} failed:`,
            err instanceof Error ? err.message : err,
          );
        }
      }
    }
  }

  console.log(
    `[fas-esr] done. rows=${totalRows} skipped_countries=${skippedCountries}`,
  );
}

function defaultMarketYears(): number[] {
  // FAS marketing years for grains/oilseeds typically run Jun-May or
  // similar; using calendar year is a reasonable approximation for
  // seeding. Operator overrides via FAS_ESR_MARKET_YEARS for
  // commodity-specific calendars.
  const now = new Date();
  const y = now.getFullYear();
  return [y, y - 1];
}

function parseMarketYears(raw: string | undefined, fallback: number[]): number[] {
  if (!raw) return fallback;
  return raw
    .split(',')
    .map((s) => Number.parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n) && n > 1900 && n < 2100);
}

function parseCommodityCodes(
  raw: string | undefined,
  fallback: number[],
): number[] {
  if (!raw) return fallback;
  return raw
    .split(',')
    .map((s) => Number.parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n));
}

function buildEsrRow(
  r: FasEsrExportRecord,
  countryCode: string,
  commodityCode: number,
  marketYear: number,
): schema.NewFasEsrWeekly {
  return {
    commodityCode,
    countryCode,
    marketYear,
    weekEndingDate: r.weekEndingDate.slice(0, 10),
    weeklyExports: numericOrNull(r.weeklyExports),
    accumulatedExportsMarketYr: numericOrNull(r.accumulatedExportsMarketYear),
    outstandingSales: numericOrNull(r.outstandingSales),
    grossNewSales: numericOrNull(r.grossNewSales),
    currentMyTotalCommitment: numericOrNull(r.currentMYTotalCommitment),
    currentMyNetSales: numericOrNull(r.currentMYNetSales),
    nextMyOutstandingSales: numericOrNull(r.nextMYOutstandingSales),
    nextMyNetSales: numericOrNull(r.nextMYNetSales),
    uomId: r.unitId ?? null,
    rawPayload: r as unknown as Record<string, unknown>,
  };
}

function numericOrNull(v: number | undefined | null): string | null {
  if (v == null || !Number.isFinite(v)) return null;
  return String(v);
}

async function upsertEsrBatch(
  db: ReturnType<typeof drizzle<typeof schema>>,
  rows: schema.NewFasEsrWeekly[],
) {
  if (rows.length === 0) return;
  await db
    .insert(schema.fasEsrWeekly)
    .values(rows)
    .onConflictDoUpdate({
      target: [
        schema.fasEsrWeekly.commodityCode,
        schema.fasEsrWeekly.countryCode,
        schema.fasEsrWeekly.marketYear,
        schema.fasEsrWeekly.weekEndingDate,
      ],
      set: {
        weeklyExports: sql`EXCLUDED.weekly_exports`,
        accumulatedExportsMarketYr: sql`EXCLUDED.accumulated_exports_market_yr`,
        outstandingSales: sql`EXCLUDED.outstanding_sales`,
        grossNewSales: sql`EXCLUDED.gross_new_sales`,
        currentMyTotalCommitment: sql`EXCLUDED.current_my_total_commitment`,
        currentMyNetSales: sql`EXCLUDED.current_my_net_sales`,
        nextMyOutstandingSales: sql`EXCLUDED.next_my_outstanding_sales`,
        nextMyNetSales: sql`EXCLUDED.next_my_net_sales`,
        uomId: sql`EXCLUDED.uom_id`,
        rawPayload: sql`EXCLUDED.raw_payload`,
        updatedAt: sql`NOW()`,
      },
    });
}

async function upsertCountryReference(
  db: ReturnType<typeof drizzle<typeof schema>>,
  countries: FasCountryRecord[],
  api: 'esr' | 'gats' | 'psd',
) {
  if (countries.length === 0) return;
  // Resolve ISO-2 for each FAS record by NAME against the seed list.
  // FAS country code shapes vary; names are the stable join key.
  const iso2ByFasCode = new Map<string, string>();
  for (const seed of FAS_SEED_COUNTRIES) {
    const match = resolveFasCountry(countries, seed);
    if (match?.countryCode != null) {
      iso2ByFasCode.set(String(match.countryCode), seed.iso2);
    }
  }
  const rows: schema.NewFasCountry[] = countries.map((c) => ({
    fasCode: String(c.countryCode),
    api,
    countryName: c.countryName,
    regionCode: c.regionCode != null ? String(c.regionCode) : null,
    iso2: iso2ByFasCode.get(String(c.countryCode)) ?? null,
    rawPayload: c as unknown as Record<string, unknown>,
  }));
  await db
    .insert(schema.fasCountries)
    .values(rows)
    .onConflictDoUpdate({
      target: [schema.fasCountries.fasCode, schema.fasCountries.api],
      set: {
        countryName: sql`EXCLUDED.country_name`,
        regionCode: sql`EXCLUDED.region_code`,
        iso2: sql`COALESCE(EXCLUDED.iso2, ${schema.fasCountries.iso2})`,
        rawPayload: sql`EXCLUDED.raw_payload`,
        updatedAt: sql`NOW()`,
      },
    });
}

async function upsertCommoditiesReference(
  db: ReturnType<typeof drizzle<typeof schema>>,
  commodities: FasEsrCommodityRecord[],
  api: 'esr' | 'gats' | 'psd',
) {
  if (commodities.length === 0) return;
  const rows: schema.NewFasCommodity[] = commodities.map((c) => ({
    commodityCode: c.commodityCode,
    api,
    commodityName: c.commodityName,
    unitId: c.unitId ?? null,
    rawPayload: c as unknown as Record<string, unknown>,
  }));
  await db
    .insert(schema.fasCommodities)
    .values(rows)
    .onConflictDoUpdate({
      target: [schema.fasCommodities.commodityCode, schema.fasCommodities.api],
      set: {
        commodityName: sql`EXCLUDED.commodity_name`,
        unitId: sql`EXCLUDED.unit_id`,
        rawPayload: sql`EXCLUDED.raw_payload`,
        updatedAt: sql`NOW()`,
      },
    });
}

main().catch((err) => {
  console.error('[fas-esr] FAILED', err);
  process.exit(1);
});
