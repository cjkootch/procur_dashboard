/**
 * Inter-American Development Bank (IDB) project ingest — Day 1
 * foundation for the MDB extraction pipeline.
 *
 * Per docs/multilateral-bank-docs-brief.md §3.1 + §8 Day 1. Discovers
 * IDB projects for the Caribbean / LATAM seed countries, persists
 * metadata to mdb_projects, optionally caches primary appraisal PDFs
 * to Vercel Blob.
 *
 * Source: https://api.iadb.org/v1/projects — free, no auth required.
 *
 * Day 1 stops at metadata + PDF caching. The LLM extraction stage
 * (Day 3) reuses the GAIN extraction stack with an MDB-specific
 * schema + prompt.
 *
 * Idempotent on (bank='idb', external_id). Re-runs UPDATE metadata
 * but never reset extraction_status (owned downstream).
 *
 * Run from repo root:
 *   pnpm --filter @procur/db ingest-mdb-idb
 *
 * Env:
 *   DATABASE_URL                # required
 *   BLOB_READ_WRITE_TOKEN       # optional — caches PDFs when set
 *   MDB_IDB_COUNTRIES=VE,JM,DO  # optional — defaults to FAS_SEED_COUNTRIES
 *   MDB_IDB_YEARS_LOOKBACK=10   # optional — default 10
 *   MDB_IDB_LIMIT_PER_COUNTRY=100 # optional — caps projects per country per run
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

const IDB_SEARCH_URL = 'https://api.iadb.org/v1/projects';

/**
 * IDB project record shape per public API (observed; not exhaustively
 * documented). Fields we depend on; we persist the full response in
 * raw_metadata so a schema drift doesn't lose data.
 */
interface IdbProjectRecord {
  projectNumber?: string;
  projectName?: string;
  countryCode?: string; // ISO-3 in IDB's response (e.g. 'JAM' for Jamaica)
  countryName?: string;
  sector?: string;
  sectorName?: string;
  projectStatus?: string;
  approvalDate?: string;
  closingDate?: string;
  estimatedTotalCost?: number | string;
  approvedAmountUsd?: number | string;
  documents?: Array<{
    documentType?: string;
    documentTitle?: string;
    documentUrl?: string;
  }>;
  [k: string]: unknown;
}

interface IdbSearchResponse {
  data?: IdbProjectRecord[];
  results?: IdbProjectRecord[];
  projects?: IdbProjectRecord[];
  total?: number;
  [k: string]: unknown;
}

/**
 * IDB publishes country codes as ISO-3. Map back to procur's ISO-2 via
 * the FAS_SEED_COUNTRIES.genc3 field which IS ISO-3 for sovereign states.
 */
function iso3ToSeedIso2(iso3: string | undefined): string | null {
  if (!iso3) return null;
  const upper = iso3.toUpperCase();
  const seed = FAS_SEED_COUNTRIES.find((c) => c.genc3 === upper);
  return seed?.iso2 ?? null;
}

async function searchCountry(
  countryIso2: string,
  yearsLookback: number,
  limit: number,
): Promise<IdbProjectRecord[]> {
  // IDB's search API accepts country name OR ISO-3. We pass the
  // canonical country name from the seed list — alias matching on
  // the API side is generous.
  const seed = FAS_SEED_COUNTRIES.find((c) => c.iso2 === countryIso2);
  if (!seed) return [];

  const fromYear = new Date().getUTCFullYear() - yearsLookback;
  const url = new URL(IDB_SEARCH_URL);
  url.searchParams.set('country', seed.name);
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('approvalDateFrom', `${fromYear}-01-01`);

  let resp: Response;
  try {
    resp = await fetch(url.toString(), {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'procur-mdb-ingest/0.1 (+https://procur.app)',
      },
    });
  } catch (err) {
    console.warn(
      `[mdb-idb] network error for ${countryIso2}: ${(err as Error).message}`,
    );
    return [];
  }

  if (!resp.ok) {
    console.warn(
      `[mdb-idb] search ${countryIso2}: HTTP ${resp.status} ${resp.statusText}`,
    );
    return [];
  }

  let parsed: IdbSearchResponse;
  try {
    parsed = (await resp.json()) as IdbSearchResponse;
  } catch (err) {
    console.warn(
      `[mdb-idb] could not parse search response for ${countryIso2}: ${(err as Error).message}`,
    );
    return [];
  }

  const list =
    parsed.data ?? parsed.results ?? parsed.projects ?? [];
  if (!Array.isArray(list)) {
    console.warn(
      `[mdb-idb] unexpected search response shape for ${countryIso2} — sample keys: ${Object.keys(parsed).join(',')}`,
    );
    return [];
  }
  return list;
}

function pickPrimaryDocument(
  documents: IdbProjectRecord['documents'],
): { url: string; title: string } | null {
  if (!documents || documents.length === 0) return null;
  // Prefer the canonical appraisal document; fall back to first available.
  const APPRAISAL_PRIORITY = [
    'project proposal',
    'loan proposal',
    'project appraisal',
    'document of the loan',
    'project profile',
  ];
  for (const wanted of APPRAISAL_PRIORITY) {
    const match = documents.find(
      (d) =>
        d.documentType?.toLowerCase().includes(wanted) ||
        d.documentTitle?.toLowerCase().includes(wanted),
    );
    if (match?.documentUrl) {
      return { url: match.documentUrl, title: match.documentTitle ?? wanted };
    }
  }
  const first = documents.find((d) => d.documentUrl);
  return first?.documentUrl
    ? { url: first.documentUrl, title: first.documentTitle ?? 'project document' }
    : null;
}

async function downloadPdf(url: string): Promise<Buffer | null> {
  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'procur-mdb-ingest/0.1 (+https://procur.app)' },
    });
    if (!resp.ok) {
      console.warn(`[mdb-idb] PDF download HTTP ${resp.status} for ${url}`);
      return null;
    }
    const buf = await resp.arrayBuffer();
    return Buffer.from(buf);
  } catch (err) {
    console.warn(
      `[mdb-idb] PDF download error for ${url}: ${(err as Error).message}`,
    );
    return null;
  }
}

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

async function uploadToBlob(
  externalId: string,
  pdf: Buffer,
): Promise<string | null> {
  if (!process.env.BLOB_READ_WRITE_TOKEN) return null;
  try {
    const key = `mdb/idb/${sha256(pdf).slice(0, 16)}-${externalId}.pdf`;
    const blob = await put(key, pdf, {
      access: 'public',
      contentType: 'application/pdf',
      addRandomSuffix: true,
    });
    return blob.url;
  } catch (err) {
    console.warn(
      `[mdb-idb] blob upload failed for ${externalId}: ${(err as Error).message}`,
    );
    return null;
  }
}

function parseDate(input: string | undefined): string | null {
  if (!input) return null;
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

function parseAmount(input: number | string | undefined): string | null {
  if (input == null) return null;
  const n = typeof input === 'number' ? input : Number.parseFloat(input);
  if (!Number.isFinite(n)) return null;
  return String(n);
}

function normalizeStatus(input: string | undefined): string | null {
  if (!input) return null;
  const lower = input.toLowerCase();
  if (lower.includes('active') || lower.includes('implementation')) return 'active';
  if (lower.includes('closed') || lower.includes('completed')) return 'closed';
  if (lower.includes('cancel')) return 'cancelled';
  if (lower.includes('pipeline') || lower.includes('preparation')) return 'pipeline';
  return lower;
}

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required.');
  }
  const db = drizzle(neon(process.env.DATABASE_URL), { schema });

  const countriesArg = process.env.MDB_IDB_COUNTRIES?.split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  const seedCountries = countriesArg
    ? FAS_SEED_COUNTRIES.filter((c) => countriesArg.includes(c.iso2))
    : FAS_SEED_COUNTRIES;

  if (seedCountries.length === 0) {
    console.error(
      '[mdb-idb] MDB_IDB_COUNTRIES filter produced an empty list. Check the env var.',
    );
    process.exit(1);
  }

  const yearsLookback = Number.parseInt(
    process.env.MDB_IDB_YEARS_LOOKBACK ?? '10',
    10,
  );
  const limit = Number.parseInt(
    process.env.MDB_IDB_LIMIT_PER_COUNTRY ?? '100',
    10,
  );

  console.log(
    `[mdb-idb] scraping ${seedCountries.length} countries, ${yearsLookback}y lookback, limit=${limit} per country`,
  );
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    console.log(
      '[mdb-idb] BLOB_READ_WRITE_TOKEN not set — PDFs will be hashed but not cached.',
    );
  }

  let totalSeen = 0;
  let totalNew = 0;
  let totalSkippedNoDoc = 0;
  let totalPdfsCached = 0;
  let totalPdfErrors = 0;
  let totalCountryMismatch = 0;

  for (const country of seedCountries) {
    console.log(`\n[mdb-idb] ${country.iso2} (${country.name})`);
    const results = await searchCountry(country.iso2, yearsLookback, limit);
    console.log(`[mdb-idb]   ${results.length} results from search API`);
    totalSeen += results.length;

    for (const r of results) {
      const externalId = r.projectNumber?.trim();
      if (!externalId) {
        continue;
      }

      // Defensive country check — IDB's API filter is generous; verify
      // the row actually belongs to the seed country to avoid noise.
      const recordIso2 = iso3ToSeedIso2(r.countryCode);
      if (recordIso2 && recordIso2 !== country.iso2) {
        totalCountryMismatch += 1;
        continue;
      }

      const doc = pickPrimaryDocument(r.documents);
      let pdfBlobUrl: string | null = null;
      let pdfHash: string | null = null;

      if (doc) {
        const pdf = await downloadPdf(doc.url);
        if (!pdf) {
          totalPdfErrors += 1;
        } else {
          pdfHash = sha256(pdf);
          pdfBlobUrl = await uploadToBlob(externalId, pdf);
          if (pdfBlobUrl) totalPdfsCached += 1;
        }
      } else {
        totalSkippedNoDoc += 1;
        // Still persist project metadata even when no primary doc;
        // procurement notices may attach later.
      }

      const insertResult = await db
        .insert(schema.mdbProjects)
        .values({
          bank: 'idb',
          externalId,
          countryCode: country.iso2,
          projectName: r.projectName ?? externalId,
          sector: r.sectorName ?? r.sector ?? null,
          status: normalizeStatus(r.projectStatus),
          approvalDate: parseDate(r.approvalDate),
          closingDate: parseDate(r.closingDate),
          totalAmountUsd: parseAmount(r.approvedAmountUsd ?? r.estimatedTotalCost),
          sourceUrl: `https://www.iadb.org/en/project/${externalId}`,
          sourceDocUrl: doc?.url ?? null,
          pdfBlobUrl,
          pdfSha256: pdfHash,
          pdfPageCount: null, // populated by Day 2 parser
          rawMetadata: r as Record<string, unknown>,
        })
        .onConflictDoUpdate({
          target: [schema.mdbProjects.bank, schema.mdbProjects.externalId],
          set: {
            projectName: sql`EXCLUDED.project_name`,
            sector: sql`EXCLUDED.sector`,
            status: sql`EXCLUDED.status`,
            approvalDate: sql`EXCLUDED.approval_date`,
            closingDate: sql`EXCLUDED.closing_date`,
            totalAmountUsd: sql`EXCLUDED.total_amount_usd`,
            sourceDocUrl: sql`EXCLUDED.source_doc_url`,
            pdfBlobUrl: sql`COALESCE(EXCLUDED.pdf_blob_url, ${schema.mdbProjects.pdfBlobUrl})`,
            pdfSha256: sql`COALESCE(EXCLUDED.pdf_sha256, ${schema.mdbProjects.pdfSha256})`,
            rawMetadata: sql`EXCLUDED.raw_metadata`,
          },
        })
        .returning({ id: schema.mdbProjects.id });

      if (insertResult.length > 0) totalNew += 1;
    }
  }

  console.log(
    `\n[mdb-idb] done — seen=${totalSeen}, persisted=${totalNew}, country-mismatch=${totalCountryMismatch}, no-doc=${totalSkippedNoDoc}, pdfs-cached=${totalPdfsCached}, pdf-errors=${totalPdfErrors}`,
  );
}

main().catch((err) => {
  console.error('[mdb-idb] FAILED', err);
  process.exit(1);
});
