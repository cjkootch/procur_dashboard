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

export interface FasClientOptions {
  apiKey?: string;
  baseUrl?: string;
  /** Override for testing. */
  fetchImpl?: typeof fetch;
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

  async function get<T>(path: string): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
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
      // 429 + 5xx: backoff. 4xx (other than 429): fail fast.
      if (res.status !== 429 && res.status < 500) {
        const body = await res.text().catch(() => '');
        throw new FasApiError(res.status, path, body);
      }
      const body = await res.text().catch(() => '');
      lastErr = new FasApiError(res.status, path, body);
      const delayMs = 1000 * 2 ** attempt; // 1s, 2s, 4s
      await new Promise((r) => setTimeout(r, delayMs));
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
  regionCode?: string | number | null;
  regionName?: string;
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
