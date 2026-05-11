/**
 * Thin client for USDA FAS Open Data Services.
 *
 *   Base: https://api.fas.usda.gov
 *   Auth: X-Api-Key header (free, signup at fas.usda.gov/data/open-data-portal)
 *   Spec: https://apps.fas.usda.gov/opendatawebV2/assets/swagger/swagger.json
 *
 * Three sub-APIs under one base:
 *   /api/esr/...   — weekly US export sales (ESR)
 *   /api/gats/...  — US Census + UN ComTrade aggregate trade flows
 *   /api/psd/...   — global production/supply/distribution forecasts
 *
 * Retry policy: 3 tries with exponential backoff on 429 + 5xx. No
 * documented rate limit but generous in practice.
 */

const DEFAULT_BASE = 'https://api.fas.usda.gov';

/** Inter-request delay (ms) — keeps us under FAS's per-minute burst
 *  limit. ~250ms = ~4 req/sec = 240/min, comfortably below the
 *  observed soft limit of ~1000/hour and the per-minute burst.
 *  Override via FAS_REQUEST_DELAY_MS env var. */
const DEFAULT_REQUEST_DELAY_MS = 250;

/** Backoff schedule when 429 is hit anyway. FAS's rate-limit window
 *  appears to be minute-scale, so short retries don't clear it. */
const RATE_LIMIT_BACKOFF_MS = [30_000, 60_000, 120_000];

export interface FasClientOptions {
  apiKey?: string;
  baseUrl?: string;
  /** Override for testing. */
  fetchImpl?: typeof fetch;
  /** Delay between successive requests (ms). Default 250ms. */
  requestDelayMs?: number;
}

export class FasApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly path: string,
    public readonly bodySnippet: string,
  ) {
    super(`FAS API ${status} on ${path}: ${bodySnippet.slice(0, 200)}`);
    this.name = 'FasApiError';
  }
}

export function createFasClient(options: FasClientOptions = {}) {
  const apiKey: string = options.apiKey ?? process.env.FAS_API_KEY ?? '';
  if (!apiKey) {
    throw new Error(
      'FAS_API_KEY is required. Sign up at https://fas.usda.gov/data/open-data-portal and set FAS_API_KEY in your .env.local.',
    );
  }
  const baseUrl = options.baseUrl ?? DEFAULT_BASE;
  const fetchImpl = options.fetchImpl ?? fetch;
  const requestDelayMs =
    options.requestDelayMs ??
    (Number.parseInt(process.env.FAS_REQUEST_DELAY_MS ?? '', 10) ||
      DEFAULT_REQUEST_DELAY_MS);

  let lastRequestAt = 0;
  async function paceRequest() {
    const elapsed = Date.now() - lastRequestAt;
    if (elapsed < requestDelayMs) {
      await new Promise((r) => setTimeout(r, requestDelayMs - elapsed));
    }
    lastRequestAt = Date.now();
  }

  async function get<T>(path: string): Promise<T> {
    let lastErr: unknown;
    let rateLimitAttempt = 0;
    for (let attempt = 0; attempt < 5; attempt++) {
      await paceRequest();
      const res = await fetchImpl(`${baseUrl}${path}`, {
        method: 'GET',
        headers: {
          'X-Api-Key': apiKey,
          Accept: 'application/json',
        },
      });
      if (res.ok) {
        return (await res.json()) as T;
      }
      // 4xx other than 429: fail fast.
      if (res.status !== 429 && res.status < 500) {
        const body = await res.text().catch(() => '');
        throw new FasApiError(res.status, path, body);
      }
      const body = await res.text().catch(() => '');
      lastErr = new FasApiError(res.status, path, body);
      if (res.status === 429) {
        const wait =
          RATE_LIMIT_BACKOFF_MS[
            Math.min(rateLimitAttempt, RATE_LIMIT_BACKOFF_MS.length - 1)
          ];
        rateLimitAttempt += 1;
        console.warn(
          `[fas-client] 429 rate limit; sleeping ${Math.round((wait ?? 0) / 1000)}s before retry`,
        );
        await new Promise((r) => setTimeout(r, wait));
      } else {
        // 5xx: short backoff
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      }
    }
    throw lastErr ?? new Error(`FAS API: unknown error on ${path}`);
  }

  return { get };
}

// ─── Reference data shapes ──────────────────────────────────────────

export interface FasCountryRecord {
  // FAS uses different code shapes across sub-APIs (sometimes string,
  // sometimes numeric). We coerce to string at ingest time and store
  // raw payload for audit.
  countryCode: string | number;
  countryName: string;
  /** Longer description / official name; not always present. */
  countryDescription?: string;
  /** Region ID (numeric or string depending on sub-API). */
  regionId?: string | number | null;
  regionCode?: string | number | null;
  regionName?: string;
  /** GENC (Geopolitical Entity, Names, and Codes) — ISO 3166-1
   *  alpha-2 compatible for sovereign states. This is the stable
   *  join key for seed-country resolution. */
  gencCode?: string;
  [k: string]: unknown;
}

export interface FasEsrCommodityRecord {
  commodityCode: number;
  commodityName: string;
  unitId?: number;
  [k: string]: unknown;
}

// ─── ESR shapes ─────────────────────────────────────────────────────

export interface FasEsrExportRecord {
  weekEndingDate: string; // ISO date
  weeklyExports: number;
  accumulatedExportsMarketYear: number;
  outstandingSales: number;
  grossNewSales: number;
  currentMYTotalCommitment: number;
  currentMYNetSales: number;
  nextMYOutstandingSales: number;
  nextMYNetSales: number;
  unitId?: number;
  commodityCode?: number;
  countryCode?: string;
  marketYear?: number;
  [k: string]: unknown;
}

// ─── UN ComTrade (via GATS) shapes ──────────────────────────────────

export interface FasUNTradeRecord {
  reporterCode: string;
  partnerCode: string;
  hsCode: string; // HS6
  year: number;
  /** Net value in USD as published by UN ComTrade. */
  value: number;
  /** Net mass in kg as published (often null for some HS codes). */
  netWeightKg?: number | null;
  /** Trade flow direction is implied by which endpoint we hit
   *  (imports vs exports vs re-exports). The ingest stamps it. */
  [k: string]: unknown;
}
