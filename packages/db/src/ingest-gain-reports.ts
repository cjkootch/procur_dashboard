/**
 * USDA FAS GAIN Report scraper — Day 1 foundation per
 * docs/gain-extraction-brief.md §8.
 *
 * Discovers GAIN reports for the Caribbean / LATAM seed countries,
 * filters to high-yield report types, persists metadata to
 * gain_reports, and (optionally) caches PDFs to Vercel Blob.
 *
 * Sources (no auth required, free):
 *   Search:   POST https://apps.fas.usda.gov/newgainapi/api/Report/SearchReports
 *   Download: GET  https://apps.fas.usda.gov/newgainapi/api/Report/DownloadReportByFileName?fileName=...
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
import { FAS_SEED_COUNTRIES } from './lib/fas-seed-countries';

loadEnv({ path: '../../.env.local' });
loadEnv({ path: '../../.env' });

const SEARCH_URL =
  'https://apps.fas.usda.gov/newgainapi/api/Report/SearchReports';
const DOWNLOAD_URL =
  'https://apps.fas.usda.gov/newgainapi/api/Report/DownloadReportByFileName';

/**
 * High-yield report types per brief §3.2. Regulatory reports (FAIRS,
 * SPS) name agencies, not commercial counterparties; filtered out.
 */
const HIGH_YIELD_REPORT_TYPES: ReadonlyArray<string> = [
  'Exporter Guide',
  'Food Service - Hotel Restaurant Institutional',
  'Retail Foods',
  'Grain and Feed Annual',
  'Grain and Feed Update',
  'Oilseeds and Products Annual',
  'Oilseeds and Products Update',
  'Sugar Annual',
  'Livestock and Products Annual',
  'Poultry and Products Annual',
  'Dairy and Products Annual',
];

/**
 * GAIN search API response shape — based on observed traffic per brief
 * §3.1. The endpoint is undocumented; if FAS changes the shape, the
 * scraper logs the raw response and exits cleanly. Fields here are the
 * subset we depend on; we persist the full response in raw_metadata.
 */
interface GainSearchResult {
  reportTitle?: string;
  countryName?: string;
  postName?: string;
  reportType?: string;
  publicationDate?: string;
  /** USDA's internal report ID — 'VE2025-0008', 'JM2025-0003', etc. */
  reportNumber?: string;
  /** URL-encoded filename component, e.g.
   *  'Venezuela+Agricultural+Imports+Grow+9+Percent_Caracas_Venezuela_VE2025-0008' */
  fileName?: string;
  [k: string]: unknown;
}

interface GainSearchResponse {
  reportList?: GainSearchResult[];
  reports?: GainSearchResult[];
  data?: GainSearchResult[];
  results?: GainSearchResult[];
  totalCount?: number;
  [k: string]: unknown;
}

async function searchCountry(
  countryName: string,
  yearsLookback: number,
  limit: number,
): Promise<GainSearchResult[]> {
  const fromYear = new Date().getUTCFullYear() - yearsLookback;
  const fromDate = `${fromYear}-01-01`;
  const toDate = new Date().toISOString().slice(0, 10);

  // POST shape based on observed traffic. The API is undocumented; if
  // the shape is wrong, log the raw response and let the operator
  // iterate. Falls back to no-op if the response shape isn't
  // recognizable.
  const body = {
    countryName,
    reportTypes: HIGH_YIELD_REPORT_TYPES,
    dateFrom: fromDate,
    dateTo: toDate,
    pageNumber: 1,
    pageSize: limit,
  };

  let resp: Response;
  try {
    resp = await fetch(SEARCH_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': 'procur-gain-ingest/0.1 (+https://procur.app)',
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    console.warn(
      `[gain] network error for ${countryName}: ${(err as Error).message}`,
    );
    return [];
  }

  if (!resp.ok) {
    console.warn(
      `[gain] search ${countryName}: HTTP ${resp.status} ${resp.statusText}`,
    );
    return [];
  }

  let parsed: GainSearchResponse;
  try {
    parsed = (await resp.json()) as GainSearchResponse;
  } catch (err) {
    console.warn(
      `[gain] could not parse search response for ${countryName}: ${(err as Error).message}`,
    );
    return [];
  }

  // FAS API responses occasionally vary in key naming; accept all
  // observed shapes.
  const list =
    parsed.reportList ?? parsed.reports ?? parsed.data ?? parsed.results ?? [];
  if (!Array.isArray(list)) {
    console.warn(
      `[gain] unexpected search response shape for ${countryName} — sample keys: ${Object.keys(parsed).join(',')}`,
    );
    return [];
  }
  return list;
}

async function downloadPdf(fileName: string): Promise<Buffer | null> {
  const url = `${DOWNLOAD_URL}?fileName=${encodeURIComponent(fileName)}`;
  try {
    const resp = await fetch(url, {
      headers: {
        'User-Agent': 'procur-gain-ingest/0.1 (+https://procur.app)',
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

  let totalSeen = 0;
  let totalNew = 0;
  let totalFilteredOut = 0;
  let totalPdfsCached = 0;
  let totalPdfErrors = 0;

  for (const country of seedCountries) {
    console.log(`\n[gain] ${country.iso2} (${country.name})`);
    const results = await searchCountry(country.name, yearsLookback, limit);
    console.log(`[gain]   ${results.length} results from search API`);
    totalSeen += results.length;

    for (const r of results) {
      const reportType = normalizeReportType(r.reportType);
      const sourceFilename = r.fileName?.trim();
      if (!sourceFilename) {
        console.warn(`[gain]   skipping result with no fileName: ${r.reportTitle ?? '(no title)'}`);
        continue;
      }
      if (!reportType || !HIGH_YIELD_REPORT_TYPES.some((t) => reportType.includes(t.slice(0, 12)))) {
        // Filter out regulatory / non-high-yield types. Substring match
        // is forgiving — USDA sometimes labels Exporter Guide as
        // "Exporter Guide Annual" etc.
        totalFilteredOut += 1;
        continue;
      }

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
          title: r.reportTitle ?? sourceFilename,
          publicationDate: parsePublicationDate(r.publicationDate),
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
    `\n[gain] done — seen=${totalSeen}, persisted=${totalNew}, filtered-out=${totalFilteredOut}, pdfs-cached=${totalPdfsCached}, pdf-errors=${totalPdfErrors}`,
  );
}

main().catch((err) => {
  console.error('[gain] FAILED', err);
  process.exit(1);
});
