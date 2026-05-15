/**
 * USDA FAS GAIN Report scraper — Day 1 foundation per
 * docs/gain-extraction-brief.md §8.
 *
 * Discovers GAIN reports for the Caribbean / LATAM seed countries,
 * filters to high-yield report types, persists metadata to
 * gain_reports, and (optionally) caches PDFs to Vercel Blob.
 *
 * Sources (free; anonymous bearer token via eAuthClient flow):
 *   Token swap: POST  https://apps.fas.usda.gov/newgainapi/token
 *               body: client_id=eAuthClient&client_secret=<anon-guid>
 *                     &grant_type=client_credentials
 *   Lookups:    GET   /Lookup/GetAllCountries     (id, locationCode (ISO-2), locationName)
 *               GET   /Lookup/GetReportCategories (id, categoryName)
 *   Search:     POST  /Search/GetSearchResults
 *               body: { keyword, categoryIds[], postIds[], postNames[],
 *                       countryIds[], fromDate, toDate }
 *   Download:   GET   /Report/DownloadReportByFileName?fileName=...
 *
 * All authenticated calls need Authorization: Bearer <access_token>.
 *
 * What this answers AFTER the Day 3 LLM extractor lands:
 *   "Who imports US wheat / soy / pork into Venezuela / DR / Jamaica?"
 *
 * Day 1 deliberately stops at metadata + PDF caching. Section
 * parsing + LLM extraction live in @procur/ai (PDFs are durable in
 * Vercel Blob; re-extractable forever).
 *
 * Idempotent on source_filename (unique index).
 *
 * Run from repo root:
 *   pnpm --filter @procur/db ingest-gain-reports
 *
 * Env:
 *   DATABASE_URL                  # required (Neon HTTP)
 *   BLOB_READ_WRITE_TOKEN         # optional — uploads PDFs to Vercel Blob when set
 *   GAIN_COUNTRIES=VE,JM,DO       # optional — defaults to FAS_SEED_COUNTRIES (10)
 *   GAIN_YEARS_LOOKBACK=5         # optional — default 5
 *   GAIN_LIMIT_PER_COUNTRY=50     # optional — caps reports per country per run
 */
import 'dotenv/config';
import { config as loadEnv } from 'dotenv';
import { createHash } from 'node:crypto';
import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import { sql } from 'drizzle-orm';
import { put } from '@vercel/blob';
import * as schema from './schema';
import {
  FAS_SEED_COUNTRIES,
  normalizeCountryName,
  type FasSeedCountry,
} from './lib/fas-seed-countries';

loadEnv({ path: '../../.env.local' });
loadEnv({ path: '../../.env' });

const API_BASE = 'https://apps.fas.usda.gov/newgainapi';
const TOKEN_URL = `${API_BASE}/token`;
const SEARCH_URL = `${API_BASE}/api/Search/GetSearchResults`;
const DOWNLOAD_URL = `${API_BASE}/api/Report/DownloadReportByFileName`;
const LOOKUP_COUNTRIES_URL = `${API_BASE}/api/Lookup/GetAllCountries`;
const LOOKUP_CATEGORIES_URL = `${API_BASE}/api/Lookup/GetReportCategories`;

/**
 * Anonymous client_credentials secret embedded in the GAIN portal's
 * Angular bundle. The portal swaps this for a 24h bearer token via
 * /newgainapi/token. Treat as a public credential — the entire flow
 * runs in browser JS for unauthenticated visitors.
 */
const ANON_CLIENT_SECRET =
  '00000000-0000-0000-0000-00000000000000000000-0000-0000-0000-000000000000';

/**
 * High-yield report categories per brief §3.2. Regulatory reports
 * (FAIRS, SPS) name agencies, not commercial counterparties; not
 * listed here. The new API consolidated old "Annual"/"Update" subkinds
 * under one category each (e.g. "Grain and Feed" covers both
 * "Grain and Feed Annual" and "Grain and Feed Update"), so we keep
 * the parent name and let publishDate-window callers chase frequency.
 */
const HIGH_YIELD_CATEGORY_NAMES: ReadonlyArray<string> = [
  'Exporter Guide',
  'Food Processing Ingredients',
  'Food Service - Hotel Restaurant Institutional',
  'Retail Foods',
  'Grain and Feed',
  'Oilseeds and Products',
  'Sugar',
  'Livestock and Products',
  'Poultry and Products',
  'Dairy and Products',
];

interface GainBearerToken {
  accessToken: string;
  expiresAt: number; // epoch ms
}

let cachedToken: GainBearerToken | null = null;

async function getBearerToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 30_000) {
    return cachedToken.accessToken;
  }
  const body = new URLSearchParams({
    client_id: 'eAuthClient',
    client_secret: ANON_CLIENT_SECRET,
    grant_type: 'client_credentials',
  });
  const resp = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
      'User-Agent': 'procur-gain-ingest/0.2 (+https://procur.app)',
    },
    body: body.toString(),
  });
  if (!resp.ok) {
    throw new Error(
      `[gain] token swap failed: HTTP ${resp.status} ${resp.statusText}`,
    );
  }
  const json = (await resp.json()) as {
    access_token?: string;
    expires_in?: number;
  };
  if (!json.access_token) {
    throw new Error('[gain] token swap response missing access_token');
  }
  const expiresIn = json.expires_in ?? 86_399;
  cachedToken = {
    accessToken: json.access_token,
    expiresAt: Date.now() + expiresIn * 1000,
  };
  return cachedToken.accessToken;
}

interface GainCountry {
  id: number;
  locationCode: string | null; // ISO-2 most of the time, occasionally region codes
  locationName: string;
}

interface GainCategory {
  id: number;
  categoryName: string;
}

interface GainLookups {
  countryIdBySeed: Map<string, number>; // keyed by seed.iso2
  highYieldCategoryIds: number[];
  categoryNameById: Map<number, string>;
}

/**
 * Match a seed country against GAIN's country list. FAS's
 * `locationCode` is its OWN 2-letter scheme — not ISO-2 — so we can't
 * just map on iso2. (TT=Trinidad → FAS TD, HT=Haiti → FAS HA,
 * DO=Dominican Rep → FAS DR, SR=Suriname → FAS NS.)
 *
 * Order:
 *   1. exact locationName match against seed.name + aliases
 *      (normalized: lowercase, accent-stripped)
 *   2. exact ISO-2 match against locationCode  — catches the
 *      countries where FAS's code happens to align with ISO-2
 *      (VE, JM, GY, CO, PA, CU all work)
 */
function resolveGainCountry(
  countries: GainCountry[],
  seed: FasSeedCountry,
): GainCountry | null {
  const wantedNames = new Set(
    [seed.name, ...seed.aliases].map(normalizeCountryName),
  );
  for (const c of countries) {
    if (wantedNames.has(normalizeCountryName(c.locationName))) return c;
  }
  for (const c of countries) {
    if (c.locationCode?.toUpperCase() === seed.iso2.toUpperCase()) return c;
  }
  return null;
}

async function loadLookups(
  seedCountries: ReadonlyArray<FasSeedCountry>,
): Promise<GainLookups> {
  const token = await getBearerToken();
  const auth = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
  const [countriesResp, categoriesResp] = await Promise.all([
    fetch(LOOKUP_COUNTRIES_URL, { headers: auth }),
    fetch(LOOKUP_CATEGORIES_URL, { headers: auth }),
  ]);
  if (!countriesResp.ok || !categoriesResp.ok) {
    throw new Error(
      `[gain] lookup load failed: countries=${countriesResp.status} categories=${categoriesResp.status}`,
    );
  }
  const countries = (await countriesResp.json()) as GainCountry[];
  const categories = (await categoriesResp.json()) as GainCategory[];

  const countryIdBySeed = new Map<string, number>();
  for (const seed of seedCountries) {
    const match = resolveGainCountry(countries, seed);
    if (match) countryIdBySeed.set(seed.iso2, match.id);
  }

  const categoryNameById = new Map(categories.map((c) => [c.id, c.categoryName]));
  const wantedSet = new Set(
    HIGH_YIELD_CATEGORY_NAMES.map((n) => n.trim().toLowerCase()),
  );
  const highYieldCategoryIds = categories
    .filter((c) => wantedSet.has(c.categoryName.trim().toLowerCase()))
    .map((c) => c.id);
  if (highYieldCategoryIds.length === 0) {
    console.warn(
      '[gain] WARNING: no high-yield categories matched the lookup — the FAS taxonomy may have shifted; passing empty categoryIds will return ALL categories',
    );
  }
  return { countryIdBySeed, highYieldCategoryIds, categoryNameById };
}

/**
 * GAIN search API response record. Field names per the live
 * /Search/GetSearchResults endpoint as of 2026-05. We persist the
 * full record in raw_metadata so additive fields are recoverable.
 */
interface GainSearchResult {
  reportId?: string; // GUID
  reportName?: string; // human-readable title
  countryName?: string;
  postName?: string;
  reportCategory?: string; // category name; may have leading whitespace
  publishDate?: string; // ISO datetime
  reportDate?: string; // ISO datetime
  /** USDA's internal report ID — 'VE2025-0008', 'JM2025-0003', etc. */
  reportNumber?: string;
  /** URL-encoded filename component, e.g.
   *  'Venezuela+Agricultural+Imports+Grow+9+Percent_Caracas_Venezuela_VE2025-0008' */
  fileName?: string;
  isPublic?: boolean;
  reportStateId?: number;
  reportState?: string;
  [k: string]: unknown;
}

async function searchCountry(
  countryIso2: string,
  countryName: string,
  countryId: number,
  highYieldCategoryIds: number[],
  yearsLookback: number,
  limit: number,
): Promise<GainSearchResult[]> {
  const fromYear = new Date().getUTCFullYear() - yearsLookback;
  const fromDate = `${fromYear}-01-01`;
  const toDate = new Date().toISOString().slice(0, 10);

  const body = {
    keyword: '',
    categoryIds: highYieldCategoryIds,
    postIds: [],
    postNames: [],
    countryIds: [countryId],
    fromDate,
    toDate,
  };

  const token = await getBearerToken();
  let resp: Response;
  try {
    resp = await fetch(SEARCH_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': 'procur-gain-ingest/0.2 (+https://procur.app)',
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    console.warn(
      `[gain] network error for ${countryIso2} (${countryName}): ${(err as Error).message}`,
    );
    return [];
  }

  if (!resp.ok) {
    console.warn(
      `[gain] search ${countryIso2}: HTTP ${resp.status} ${resp.statusText}`,
    );
    return [];
  }

  let parsed: unknown;
  try {
    parsed = await resp.json();
  } catch (err) {
    console.warn(
      `[gain] could not parse search response for ${countryIso2}: ${(err as Error).message}`,
    );
    return [];
  }

  if (!Array.isArray(parsed)) {
    console.warn(
      `[gain] unexpected search response shape for ${countryIso2} — expected array; got ${typeof parsed}`,
    );
    return [];
  }
  return (parsed as GainSearchResult[]).slice(0, limit);
}

async function downloadPdf(fileName: string): Promise<Buffer | null> {
  const url = `${DOWNLOAD_URL}?fileName=${encodeURIComponent(fileName)}`;
  try {
    const token = await getBearerToken();
    const resp = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        'User-Agent': 'procur-gain-ingest/0.2 (+https://procur.app)',
      },
    });
    if (!resp.ok) {
      console.warn(`[gain] download ${fileName}: HTTP ${resp.status}`);
      return null;
    }
    const arrayBuf = await resp.arrayBuffer();
    return Buffer.from(arrayBuf);
  } catch (err) {
    console.warn(
      `[gain] download error for ${fileName}: ${(err as Error).message}`,
    );
    return null;
  }
}

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

async function uploadToBlob(
  fileName: string,
  pdf: Buffer,
): Promise<string | null> {
  if (!process.env.BLOB_READ_WRITE_TOKEN) return null;
  try {
    const key = `gain-reports/${sha256(pdf).slice(0, 16)}-${fileName.slice(0, 100)}.pdf`;
    const blob = await put(key, pdf, {
      access: 'public',
      contentType: 'application/pdf',
      addRandomSuffix: true,
    });
    return blob.url;
  } catch (err) {
    console.warn(
      `[gain] blob upload failed for ${fileName}: ${(err as Error).message}`,
    );
    return null;
  }
}

function parsePublicationDate(input: string | undefined): string | null {
  if (!input) return null;
  // Accept ISO + USDA formats: '2025-04-15', '04/15/2025', '4/15/2025 12:00:00 AM'.
  const trimmed = input.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(trimmed);
  if (iso?.[1] && iso[2] && iso[3]) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(trimmed);
  if (us?.[1] && us[2] && us[3]) {
    const mm = us[1].padStart(2, '0');
    const dd = us[2].padStart(2, '0');
    return `${us[3]}-${mm}-${dd}`;
  }
  return null;
}

function normalizeReportType(input: string | undefined): string | null {
  if (!input) return null;
  const trimmed = input.trim();
  // Tolerate the HRI long-form variants. Anything in HIGH_YIELD_REPORT_TYPES
  // passes through; other values land verbatim so we can spot new high-yield
  // types in raw_metadata that we haven't whitelisted yet.
  return trimmed;
}

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required.');
  }
  const db = drizzle(neon(process.env.DATABASE_URL), { schema });

  const countriesArg = process.env.GAIN_COUNTRIES?.split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  const seedCountries = countriesArg
    ? FAS_SEED_COUNTRIES.filter((c) => countriesArg.includes(c.iso2))
    : FAS_SEED_COUNTRIES;

  if (seedCountries.length === 0) {
    console.error(
      '[gain] GAIN_COUNTRIES filter produced an empty list. Check the env var.',
    );
    process.exit(1);
  }

  const yearsLookback = Number.parseInt(
    process.env.GAIN_YEARS_LOOKBACK ?? '5',
    10,
  );
  const limit = Number.parseInt(
    process.env.GAIN_LIMIT_PER_COUNTRY ?? '50',
    10,
  );

  console.log(
    `[gain] scraping ${seedCountries.length} countries, ${yearsLookback}y lookback, limit=${limit} per country`,
  );
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    console.log(
      '[gain] BLOB_READ_WRITE_TOKEN not set — PDFs will be hashed but not cached. The Day 3 extractor will need to re-download.',
    );
  }

  console.log('[gain] loading country + category lookups…');
  const lookups = await loadLookups(seedCountries);
  console.log(
    `[gain]   ${lookups.countryIdBySeed.size}/${seedCountries.length} seed countries resolved, ${lookups.highYieldCategoryIds.length} high-yield categories matched`,
  );

  let totalSeen = 0;
  let totalNew = 0;
  let totalSkippedNoFile = 0;
  let totalPdfsCached = 0;
  let totalPdfErrors = 0;

  for (const country of seedCountries) {
    console.log(`\n[gain] ${country.iso2} (${country.name})`);
    const countryId = lookups.countryIdBySeed.get(country.iso2);
    if (countryId == null) {
      console.warn(
        `[gain]   ${country.iso2}: no FAS country id — skipping (lookup missing)`,
      );
      continue;
    }
    const results = await searchCountry(
      country.iso2,
      country.name,
      countryId,
      lookups.highYieldCategoryIds,
      yearsLookback,
      limit,
    );
    console.log(`[gain]   ${results.length} results from search API`);
    totalSeen += results.length;

    for (const r of results) {
      const sourceFilename = r.fileName?.trim();
      if (!sourceFilename) {
        totalSkippedNoFile += 1;
        continue;
      }
      // Fallback for the rare null-category record — shouldn't happen
      // since we filtered server-side via categoryIds, but the column
      // is NOT NULL so guard anyway.
      const reportType = normalizeReportType(r.reportCategory) ?? 'Unknown';

      const pdf = await downloadPdf(sourceFilename);
      if (!pdf) {
        totalPdfErrors += 1;
        continue;
      }
      const hash = sha256(pdf);
      const blobUrl = await uploadToBlob(sourceFilename, pdf);
      if (blobUrl) totalPdfsCached += 1;

      const sourceUrl = `${DOWNLOAD_URL}?fileName=${encodeURIComponent(sourceFilename)}`;
      const insertResult = await db
        .insert(schema.gainReports)
        .values({
          reportId: r.reportNumber ?? null,
          countryCode: country.iso2,
          postCity: r.postName ?? null,
          reportType,
          title: r.reportName ?? sourceFilename,
          publicationDate: parsePublicationDate(r.publishDate),
          sourceFilename,
          sourceUrl,
          pdfBlobUrl: blobUrl,
          pdfSha256: hash,
          pdfPageCount: null, // populated by Day 2 parser
          rawMetadata: r as Record<string, unknown>,
        })
        .onConflictDoUpdate({
          target: schema.gainReports.sourceFilename,
          set: {
            // Only update fields that can legitimately change on re-discovery.
            // Don't reset extraction_status — that's owned by the extractor.
            title: sql`EXCLUDED.title`,
            publicationDate: sql`EXCLUDED.publication_date`,
            pdfBlobUrl: sql`COALESCE(EXCLUDED.pdf_blob_url, ${schema.gainReports.pdfBlobUrl})`,
            pdfSha256: sql`EXCLUDED.pdf_sha256`,
            rawMetadata: sql`EXCLUDED.raw_metadata`,
          },
        })
        .returning({ id: schema.gainReports.id });

      if (insertResult.length > 0) totalNew += 1;
    }
  }

  console.log(
    `\n[gain] done — seen=${totalSeen}, persisted=${totalNew}, skipped-no-file=${totalSkippedNoFile}, pdfs-cached=${totalPdfsCached}, pdf-errors=${totalPdfErrors}`,
  );
}

main().catch((err) => {
  console.error('[gain] FAILED', err);
  process.exit(1);
});
