/**
 * World Bank project ingest — Day 2 of multilateral-bank-docs-brief.md.
 *
 * Pulls World Bank projects for the Caribbean / LATAM seed countries
 * via the public search API. Same shape as `ingest-mdb-idb.ts`:
 * persists metadata to `mdb_projects`, optionally caches primary
 * appraisal PDFs to Vercel Blob.
 *
 * Source: https://search.worldbank.org/api/v3/projects — free, no auth.
 *
 * Idempotent on (bank='worldbank', external_id). Re-runs UPDATE
 * metadata but never reset extraction_status (owned by Day 3 LLM).
 *
 * Run from repo root:
 *   pnpm --filter @procur/db ingest-mdb-worldbank
 *
 * Env:
 *   DATABASE_URL                  # required
 *   BLOB_READ_WRITE_TOKEN         # optional — caches PDFs when set
 *   MDB_WB_COUNTRIES=VE,JM,DO     # optional — defaults to FAS_SEED_COUNTRIES
 *   MDB_WB_YEARS_LOOKBACK=10      # optional — default 10
 *   MDB_WB_LIMIT_PER_COUNTRY=200  # optional — caps projects per country per run
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

const WB_SEARCH_URL = 'https://search.worldbank.org/api/v3/projects';

/**
 * World Bank project record. The API returns projects as a keyed
 * object (`projects: { P172332: {...}, P175643: {...} }`) rather than
 * a flat array — parser handles both shapes defensively. Field names
 * here match WB's canonical naming.
 */
interface WbProjectRecord {
  id?: string;
  project_name?: string;
  countrycode?: string;
  countryshortname?: string;
  countryname?: string;
  sector?: string | Array<{ Name?: string }>;
  sector1?: { Name?: string };
  major_sector_name?: string;
  status?: string;
  projectstatusdisplay?: string;
  boardapprovaldate?: string;
  closingdate?: string;
  /** `totalamt` is the V3 field that actually carries value;
   *  `totalcommamt` is the older alias. Try both. */
  totalamt?: number | string;
  totalcommamt?: number | string;
  url?: string;
  /** Document list shape varies; the API publishes some doc links in
   *  `projectdocs[]` and others via the separate documents.worldbank.org
   *  search. Day 1 only consumes top-level doc URLs when present. */
  projectdocs?: Array<{
    DocURL?: string;
    DocTypeName?: string;
    DocTitle?: string;
  }>;
  [k: string]: unknown;
}

interface WbSearchResponse {
  projects?: Record<string, WbProjectRecord> | WbProjectRecord[];
  total?: number;
  [k: string]: unknown;
}

async function searchCountry(
  countryIso2: string,
  yearsLookback: number,
  limit: number,
): Promise<WbProjectRecord[]> {
  const seed = FAS_SEED_COUNTRIES.find((c) => c.iso2 === countryIso2);
  if (!seed) return [];

  const fromYear = new Date().getUTCFullYear() - yearsLookback;
  const url = new URL(WB_SEARCH_URL);
  url.searchParams.set('format', 'json');
  // WB's countrycode_exact filter expects ISO-2 (e.g. "VE"), not ISO-3
  // — passing GENC3 silently returns total=0 for every country.
  url.searchParams.set('countrycode_exact', seed.iso2);
  url.searchParams.set('rows', String(limit));
  url.searchParams.set(
    'fl',
    [
      'id',
      'project_name',
      'countrycode',
      'countryshortname',
      'countryname',
      'sector1',
      'sector',
      'major_sector_name',
      'status',
      'projectstatusdisplay',
      'boardapprovaldate',
      'closingdate',
      'totalamt',
      'totalcommamt',
      'url',
      'projectdocs',
    ].join(','),
  );
  url.searchParams.set('boardapprovaldate_fromdt', `${fromYear}-01-01T00:00:00Z`);

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
      `[mdb-wb] network error for ${countryIso2}: ${(err as Error).message}`,
    );
    return [];
  }

  if (!resp.ok) {
    console.warn(`[mdb-wb] search ${countryIso2}: HTTP ${resp.status}`);
    return [];
  }

  let parsed: WbSearchResponse;
  try {
    parsed = (await resp.json()) as WbSearchResponse;
  } catch (err) {
    console.warn(
      `[mdb-wb] could not parse search response for ${countryIso2}: ${(err as Error).message}`,
    );
    return [];
  }

  if (!parsed.projects) return [];
  if (Array.isArray(parsed.projects)) return parsed.projects;
  return Object.values(parsed.projects);
}

function pickPrimaryDocument(
  documents: WbProjectRecord['projectdocs'],
): { url: string; title: string } | null {
  if (!documents || documents.length === 0) return null;
  const APPRAISAL_PRIORITY = [
    'project appraisal',
    'project information',
    'program-for-results',
    'program document',
    'pad',
    'loan agreement',
  ];
  for (const wanted of APPRAISAL_PRIORITY) {
    const match = documents.find(
      (d) =>
        d.DocTypeName?.toLowerCase().includes(wanted) ||
        d.DocTitle?.toLowerCase().includes(wanted),
    );
    if (match?.DocURL) {
      return { url: match.DocURL, title: match.DocTitle ?? wanted };
    }
  }
  const first = documents.find((d) => d.DocURL);
  return first?.DocURL
    ? { url: first.DocURL, title: first.DocTitle ?? 'project document' }
    : null;
}

async function downloadPdf(url: string): Promise<Buffer | null> {
  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'procur-mdb-ingest/0.1 (+https://procur.app)' },
    });
    if (!resp.ok) {
      console.warn(`[mdb-wb] PDF download HTTP ${resp.status} for ${url}`);
      return null;
    }
    return Buffer.from(await resp.arrayBuffer());
  } catch (err) {
    console.warn(`[mdb-wb] PDF download error for ${url}: ${(err as Error).message}`);
    return null;
  }
}

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

async function uploadToBlob(externalId: string, pdf: Buffer): Promise<string | null> {
  if (!process.env.BLOB_READ_WRITE_TOKEN) return null;
  try {
    const key = `mdb/worldbank/${sha256(pdf).slice(0, 16)}-${externalId}.pdf`;
    const blob = await put(key, pdf, {
      access: 'public',
      contentType: 'application/pdf',
      addRandomSuffix: true,
    });
    return blob.url;
  } catch (err) {
    console.warn(
      `[mdb-wb] blob upload failed for ${externalId}: ${(err as Error).message}`,
    );
    return null;
  }
}

function parseDate(input: string | undefined): string | null {
  if (!input) return null;
  // World Bank uses ISO datetimes ('2024-03-15T00:00:00Z') and bare dates.
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(input.trim());
  if (iso?.[1] && iso[2] && iso[3]) return `${iso[1]}-${iso[2]}-${iso[3]}`;
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
  if (lower.includes('cancel') || lower.includes('drop')) return 'cancelled';
  if (lower.includes('pipeline') || lower.includes('preparation')) return 'pipeline';
  return lower;
}

function extractSectorName(
  sector: WbProjectRecord['sector'],
  sector1: WbProjectRecord['sector1'],
  majorSectorName?: string,
): string | null {
  if (majorSectorName) return majorSectorName;
  if (sector1?.Name) return sector1.Name;
  if (typeof sector === 'string') return sector;
  if (Array.isArray(sector) && sector[0]?.Name) return sector[0].Name;
  return null;
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
  const db = drizzle(neon(process.env.DATABASE_URL), { schema });

  const countriesArg = process.env.MDB_WB_COUNTRIES?.split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  const seedCountries = countriesArg
    ? FAS_SEED_COUNTRIES.filter((c) => countriesArg.includes(c.iso2))
    : FAS_SEED_COUNTRIES;

  if (seedCountries.length === 0) {
    console.error('[mdb-wb] MDB_WB_COUNTRIES filter produced an empty list.');
    process.exit(1);
  }

  const yearsLookback = Number.parseInt(process.env.MDB_WB_YEARS_LOOKBACK ?? '10', 10);
  const limit = Number.parseInt(process.env.MDB_WB_LIMIT_PER_COUNTRY ?? '200', 10);

  console.log(
    `[mdb-wb] scraping ${seedCountries.length} countries, ${yearsLookback}y lookback, limit=${limit} per country`,
  );
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    console.log('[mdb-wb] BLOB_READ_WRITE_TOKEN not set — PDFs will be hashed but not cached.');
  }

  let totalSeen = 0;
  let totalNew = 0;
  let totalSkippedNoDoc = 0;
  let totalPdfsCached = 0;
  let totalPdfErrors = 0;

  for (const country of seedCountries) {
    console.log(`\n[mdb-wb] ${country.iso2} (${country.name})`);
    const results = await searchCountry(country.iso2, yearsLookback, limit);
    console.log(`[mdb-wb]   ${results.length} results from search API`);
    totalSeen += results.length;

    for (const r of results) {
      const externalId = r.id?.trim();
      if (!externalId) continue;

      const doc = pickPrimaryDocument(r.projectdocs);
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
      }

      const insertResult = await db
        .insert(schema.mdbProjects)
        .values({
          bank: 'worldbank',
          externalId,
          countryCode: country.iso2,
          projectName: r.project_name ?? externalId,
          sector: extractSectorName(r.sector, r.sector1, r.major_sector_name),
          status: normalizeStatus(r.projectstatusdisplay ?? r.status),
          approvalDate: parseDate(r.boardapprovaldate),
          closingDate: parseDate(r.closingdate),
          totalAmountUsd: parseAmount(r.totalamt ?? r.totalcommamt),
          sourceUrl: r.url ?? `https://projects.worldbank.org/en/projects-operations/project-detail/${externalId}`,
          sourceDocUrl: doc?.url ?? null,
          pdfBlobUrl,
          pdfSha256: pdfHash,
          pdfPageCount: null,
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
    `\n[mdb-wb] done — seen=${totalSeen}, persisted=${totalNew}, no-doc=${totalSkippedNoDoc}, pdfs-cached=${totalPdfsCached}, pdf-errors=${totalPdfErrors}`,
  );
}

main().catch((err) => {
  console.error('[mdb-wb] FAILED', err);
  process.exit(1);
});
