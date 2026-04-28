/**
 * Eurostat Comext ingest — extra-EU monthly trade flows by HS code.
 *
 * Source: Eurostat dissemination API (free, no auth)
 *   Base: https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/{dataset}
 *   Format: JSON-stat 2.0
 *
 * What this answers (with default args):
 *   "Which EU countries imported crude petroleum (HS 2709) from Libya
 *    each month over the last 24 months?"
 *
 * Country-level granularity. Does NOT replace per-cargo data
 * (Kpler/Vortexa); pairs with the refinery rolodex in `known_entities`
 * to attribute country imports to candidate refiners with reasonable
 * confidence.
 *
 * Idempotent on the unique (source, reporter, partner, product, flow,
 * period) tuple. Re-running updates values + raw_payload.
 *
 * Run from repo root:
 *   pnpm --filter @procur/db ingest-eurostat-comext
 *
 * Env overrides:
 *   EUROSTAT_DATASET=ext_lt_extracn8        # default; alternate: ext_st_27_2020sitc
 *   EUROSTAT_PRODUCT=2709                   # HS code, defaults to crude petroleum
 *   EUROSTAT_PARTNER=LY                     # ISO-2 country of origin (Libya)
 *   EUROSTAT_LOOKBACK_MONTHS=24             # how far back to ingest
 *
 * Docs: https://ec.europa.eu/eurostat/web/main/data/web-services
 *       https://json-stat.org/format/
 */
import 'dotenv/config';
import { config as loadEnv } from 'dotenv';
import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import * as schema from './schema';

loadEnv({ path: '../../.env.local' });
loadEnv({ path: '../../.env' });

const EUROSTAT_BASE =
  'https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data';

// ─── EUR → USD inlined to avoid the cyclic dep with @procur/scrapers-core
//      that imports from @procur/db. Keep in sync with packages/scrapers-core/src/fx.ts.
const EUR_MONTHLY_USD: Record<string, number> = {
  '2021-01': 1.218, '2021-06': 1.205, '2021-12': 1.130,
  '2022-01': 1.131, '2022-06': 1.058, '2022-12': 1.063,
  '2023-01': 1.079, '2023-06': 1.087, '2023-12': 1.090,
  '2024-01': 1.090, '2024-06': 1.078, '2024-12': 1.045,
  '2025-01': 1.038, '2025-06': 1.075, '2025-12': 1.075,
  '2026-01': 1.080, '2026-06': 1.080,
};
const EUR_BASELINE_USD = 1.07;

function eurToUsd(eurAmount: number, period: string /* YYYY-MM */): number {
  const direct = EUR_MONTHLY_USD[period];
  if (direct != null) return eurAmount * direct;
  return eurAmount * EUR_BASELINE_USD;
}

// ─── JSON-stat 2.0 unflattening ──────────────────────────────────────
//
// Eurostat returns the dataset's multi-dimensional cube as a flat
// `value` map keyed by row-major index. To recover (reporter, partner,
// product, period, ...) we need:
//   - `id`: array of dimension names in order
//   - `size`: parallel array of dimension lengths
//   - `dimension[d].category.index`: map of category-id -> position in the dimension
//
// Decoding row-major: i = sum(d_k * stride_k) where stride_k = product
// of size[k+1..N-1]. Inverse uses div + mod.

type JsonStatDataset = {
  version: string;
  id?: string[];
  size?: number[];
  dimension: Record<
    string,
    {
      category: {
        index: Record<string, number> | string[];
        label?: Record<string, string>;
      };
    }
  >;
  value: Record<string, number> | number[];
  source?: string;
  updated?: string;
};

type DecodedRow = {
  /** Map from dimension name to category id (e.g. {reporter: 'IT', partner: 'LY', ...}). */
  coords: Record<string, string>;
  value: number;
};

function decodeJsonStat(ds: JsonStatDataset): DecodedRow[] {
  const dimNames = ds.id ?? Object.keys(ds.dimension);
  const sizes = ds.size ?? dimNames.map((d) => sizeOf(ds.dimension[d]?.category.index));

  // Per-dimension reverse lookup: position -> category id.
  const reverseIndex: Record<string, string[]> = {};
  for (const name of dimNames) {
    const idx = ds.dimension[name]?.category.index;
    if (!idx) {
      reverseIndex[name] = [];
      continue;
    }
    if (Array.isArray(idx)) {
      reverseIndex[name] = idx;
    } else {
      const arr: string[] = new Array(Object.keys(idx).length).fill('');
      for (const [k, v] of Object.entries(idx)) arr[v] = k;
      reverseIndex[name] = arr;
    }
  }

  // Strides for row-major decoding.
  const strides: number[] = new Array(dimNames.length).fill(1);
  for (let i = dimNames.length - 2; i >= 0; i -= 1) {
    strides[i] = (strides[i + 1] ?? 1) * (sizes[i + 1] ?? 1);
  }

  const out: DecodedRow[] = [];
  const valueEntries =
    Array.isArray(ds.value)
      ? ds.value
          .map((v, i) => [i, v] as [number, number])
          .filter(([, v]) => v != null)
      : Object.entries(ds.value).map(([k, v]) => [Number.parseInt(k, 10), v] as [number, number]);

  for (const [idx, value] of valueEntries) {
    if (!Number.isFinite(value)) continue;
    let remaining = idx;
    const coords: Record<string, string> = {};
    for (let d = 0; d < dimNames.length; d += 1) {
      const dimName = dimNames[d];
      const stride = strides[d];
      if (!dimName || stride == null) continue;
      const pos = Math.floor(remaining / stride);
      remaining %= stride;
      const reverse = reverseIndex[dimName];
      coords[dimName] = reverse?.[pos] ?? String(pos);
    }
    out.push({ coords, value });
  }

  return out;
}

function sizeOf(idx: Record<string, number> | string[] | undefined): number {
  if (!idx) return 0;
  return Array.isArray(idx) ? idx.length : Object.keys(idx).length;
}

// ─── Eurostat fetch + ingest ─────────────────────────────────────────

type Args = {
  dataset: string;
  product: string;
  partner: string;
  monthsLookback: number;
};

function buildPeriods(monthsLookback: number): string[] {
  const periods: string[] = [];
  const now = new Date();
  for (let i = 0; i < monthsLookback; i += 1) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const period = `${d.getUTCFullYear()}M${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    periods.push(period);
  }
  return periods;
}

async function fetchEurostat(args: Args): Promise<JsonStatDataset> {
  const params = new URLSearchParams({
    format: 'JSON',
    lang: 'EN',
    product: args.product,
    partner: args.partner,
    flow: '1', // 1 = import
    indicators: 'QUANTITY,VALUE_IN_EUROS',
  });
  for (const p of buildPeriods(args.monthsLookback)) params.append('period', p);

  const url = `${EUROSTAT_BASE}/${args.dataset}?${params.toString()}`;
  console.log(`Fetching ${url}`);
  const res = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'procur-research/1.0 (cole@vectortradecapital.com)',
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `Eurostat ${res.status} for ${args.dataset}: ${body.slice(0, 500)}\n` +
        `Tip: dataset code may have changed. Override with EUROSTAT_DATASET=...`,
    );
  }
  return (await res.json()) as JsonStatDataset;
}

function periodToIso(period: string): string | null {
  // Eurostat period strings: '2024M06' or '2024'.
  const monthly = period.match(/^(\d{4})M(\d{2})$/);
  if (monthly) return `${monthly[1]}-${monthly[2]}-01`;
  const annual = period.match(/^(\d{4})$/);
  if (annual) return `${annual[1]}-01-01`;
  return null;
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set');

  const args: Args = {
    dataset: process.env.EUROSTAT_DATASET ?? 'ext_lt_extracn8',
    product: process.env.EUROSTAT_PRODUCT ?? '2709',
    partner: process.env.EUROSTAT_PARTNER ?? 'LY',
    monthsLookback: Number.parseInt(process.env.EUROSTAT_LOOKBACK_MONTHS ?? '24', 10),
  };
  console.log('Eurostat Comext ingest', args);

  // The HS-detail Comext datasets (ext_lt_extracn8, ds_059341, etc.)
  // are no longer exposed via the dissemination API — Eurostat moved
  // them to bulk-download-only (TSV.gz). Aggregate datasets like
  // ext_lt_intratrd or ext_lt_maineu work but lack the HS detail we
  // need. The 404 response below is expected; UN Comtrade is the
  // primary source for global HS-detail trade flows now.
  let ds: JsonStatDataset;
  try {
    ds = await fetchEurostat(args);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('404')) {
      console.warn(
        `Eurostat dataset '${args.dataset}' is not available via dissemination API.\n` +
          `HS-detail data was moved to bulk-download in late 2023; aggregate datasets are still available.\n` +
          `Use UN Comtrade for HS-level customs flows: pnpm --filter @procur/db ingest-un-comtrade\n` +
          `Or override EUROSTAT_DATASET=ext_lt_intratrd for SITC-level aggregates.`,
      );
      return;
    }
    throw err;
  }
  console.log(`  source: ${ds.source ?? '?'}, updated: ${ds.updated ?? '?'}`);
  console.log(`  dimensions: ${(ds.id ?? Object.keys(ds.dimension)).join(', ')}`);

  const decoded = decodeJsonStat(ds);
  console.log(`  ${decoded.length} cell rows`);

  // Group by (reporter, period) and split QUANTITY vs VALUE indicators.
  // The "indicators" dimension is what splits these in Eurostat's response —
  // sometimes called `indic_bop`, `indic_de`, or just `indicators`.
  type Bucket = { quantityKg: number | null; valueEur: number | null; product: string; reporter: string; period: string };
  const buckets = new Map<string, Bucket>();
  for (const row of decoded) {
    const reporter = row.coords.reporter ?? row.coords.geo ?? row.coords.partner ?? '';
    if (!reporter || reporter === args.partner) continue; // skip self / Libya
    const period = row.coords.time ?? row.coords.period ?? '';
    if (!period) continue;
    const indicator =
      row.coords.indicators ??
      row.coords.indic_bop ??
      row.coords.indic_de ??
      'VALUE';
    const key = `${reporter}::${period}`;
    let b = buckets.get(key);
    if (!b) {
      b = {
        quantityKg: null,
        valueEur: null,
        product: row.coords.product ?? args.product,
        reporter,
        period,
      };
      buckets.set(key, b);
    }
    const ind = String(indicator).toUpperCase();
    if (ind.includes('QUANTITY') || ind === 'QUANTITY_IN_100KG' || ind === 'QUANT_KG') {
      // Eurostat publishes quantity in 100kg units when source says so;
      // the indicator label is the truth. Convert to kg.
      const factor = ind.includes('100KG') ? 100 : 1;
      b.quantityKg = row.value * factor;
    } else if (ind.includes('VALUE') || ind === 'VALUE_IN_EUROS') {
      b.valueEur = row.value;
    }
  }

  console.log(`  ${buckets.size} (reporter, period) tuples`);

  const client = neon(url);
  const db = drizzle(client, { schema, casing: 'snake_case' });

  let upserted = 0;
  for (const b of buckets.values()) {
    const periodIso = periodToIso(b.period);
    if (!periodIso) continue;
    const periodKey = periodIso.slice(0, 7); // YYYY-MM for FX lookup
    const valueUsd = b.valueEur != null ? eurToUsd(b.valueEur, periodKey) : null;

    await db
      .insert(schema.customsImports)
      .values({
        source: 'eurostat-comext',
        reporterCountry: b.reporter,
        partnerCountry: args.partner,
        productCode: b.product,
        productLabel: ds.dimension.product?.category.label?.[b.product] ?? null,
        flowDirection: 'import',
        period: periodIso,
        periodGranularity: 'M',
        quantityKg: b.quantityKg != null ? String(b.quantityKg) : null,
        valueNative: b.valueEur != null ? String(b.valueEur) : null,
        valueCurrency: 'EUR',
        valueUsd: valueUsd != null ? String(valueUsd) : null,
        rawPayload: {
          dataset: args.dataset,
          source_updated: ds.updated,
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
          quantityKg: b.quantityKg != null ? String(b.quantityKg) : null,
          valueNative: b.valueEur != null ? String(b.valueEur) : null,
          valueUsd: valueUsd != null ? String(valueUsd) : null,
          updatedAt: new Date(),
        },
      });
    upserted += 1;
  }
  console.log(`Done. upserted=${upserted}`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
