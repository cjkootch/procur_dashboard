/**
 * International Finance Corporation (IFC) project ingest — Day 3 of
 * multilateral-bank-docs-brief.md.
 *
 * IFC is the World Bank Group's private-sector arm — every funded
 * project = named private-sector recipient. **Highest signal-to-noise
 * for commercial counterparties** of the four MDBs procur covers.
 *
 * Source: IFC Disclosures Portal at disclosures.ifc.org (HTML +
 * downloadable Project Disclosure documents). No documented public
 * API; we scrape the search page with a country filter.
 *
 * Polite-crawler: 2s delay between requests.
 *
 * Idempotent on (bank='ifc', external_id) where external_id is IFC's
 * project number (e.g. '47892'), parsed from the search-result links.
 *
 * Run from repo root:
 *   pnpm --filter @procur/db ingest-mdb-ifc
 *
 * Env:
 *   DATABASE_URL                  # required
 *   BLOB_READ_WRITE_TOKEN         # optional — caches PDFs when set
 *   MDB_IFC_COUNTRIES=VE,JM,DO    # optional — defaults to FAS_SEED_COUNTRIES
 *   MDB_IFC_SEARCH_URL=...        # optional override for testing
 */
import 'dotenv/config';
import { config as loadEnv } from 'dotenv';
import { createHash } from 'node:crypto';
import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import { sql } from 'drizzle-orm';
import { put } from '@vercel/blob';
import * as cheerio from 'cheerio';
import * as schema from './schema';
import { FAS_SEED_COUNTRIES } from './lib/fas-seed-countries';

loadEnv({ path: '../../.env.local' });
loadEnv({ path: '../../.env' });

const DEFAULT_SEARCH_URL = 'https://disclosures.ifc.org/project-search';

interface ParsedIfcProject {
  externalId: string;
  projectName: string;
  countryName: string | null;
  sector: string | null;
  status: string | null;
  approvalDate: string | null;
  totalAmountUsd: string | null;
  projectUrl: string;
  primaryDocUrl: string | null;
}

async function fetchHtml(url: string): Promise<string | null> {
  await new Promise((r) => setTimeout(r, 2000));
  try {
    const resp = await fetch(url, {
      headers: {
        Accept: 'text/html',
        'User-Agent': 'procur-mdb-ingest/0.1 (+https://procur.app)',
      },
    });
    if (!resp.ok) {
      console.warn(`[mdb-ifc] HTTP ${resp.status} for ${url}`);
      return null;
    }
    return await resp.text();
  } catch (err) {
    console.warn(`[mdb-ifc] fetch error: ${(err as Error).message}`);
    return null;
  }
}

function parseSearchResults(html: string, countryIso2: string): ParsedIfcProject[] {
  const $ = cheerio.load(html);
  const projects: ParsedIfcProject[] = [];

  // IFC's disclosures portal renders results as card / list items.
  // We accept several possible DOM shapes defensively. Primary
  // heuristic: any link whose href matches /project/(\d+) is a
  // project URL; the surrounding container has the metadata.
  $('a[href*="/project/"]').each((_, anchor) => {
    const href = $(anchor).attr('href') ?? '';
    const m = /\/project\/(\d+)/.exec(href);
    if (!m?.[1]) return;
    const externalId = m[1];

    // Walk up to find a "card" container — heuristically the nearest
    // ancestor with multiple siblings carrying project metadata.
    const card = $(anchor).closest('article, li, .card, .project, [data-project], div');
    const cardText = card.text();

    const projectName = $(anchor).text().trim() || 'Unknown project';
    const countryMatch =
      /(?:country|location|where)\s*[:\-—]\s*([^\n,]+)/i.exec(cardText);
    const sectorMatch =
      /(?:sector|industry)\s*[:\-—]\s*([^\n,]+)/i.exec(cardText);
    const statusMatch =
      /(?:status|stage)\s*[:\-—]\s*([^\n,]+)/i.exec(cardText);
    const amountMatch =
      /\$\s*([\d.,]+)\s*(million|m|billion|bn|b)?/i.exec(cardText);

    let totalAmountUsd: string | null = null;
    if (amountMatch?.[1]) {
      const n = Number.parseFloat(amountMatch[1].replace(/,/g, ''));
      const mult =
        amountMatch[2]?.toLowerCase().startsWith('b') ? 1_000_000_000 :
        amountMatch[2]?.toLowerCase().startsWith('m') ? 1_000_000 : 1;
      if (Number.isFinite(n)) totalAmountUsd = String(n * mult);
    }

    projects.push({
      externalId,
      projectName,
      countryName: countryMatch?.[1]?.trim() ?? null,
      sector: sectorMatch?.[1]?.trim() ?? null,
      status: statusMatch?.[1]?.trim() ?? null,
      approvalDate: null,
      totalAmountUsd,
      projectUrl: href.startsWith('http') ? href : `https://disclosures.ifc.org${href}`,
      primaryDocUrl: null, // populated by per-project fetch
    });
  });

  // Dedupe by externalId — multiple anchors can link to the same project.
  const byId = new Map<string, ParsedIfcProject>();
  for (const p of projects) {
    if (!byId.has(p.externalId)) byId.set(p.externalId, p);
  }
  // countryIso2 is the seed we filtered for in the request; trust it
  // unless the parsed countryName disagrees clearly.
  return Array.from(byId.values()).filter((p) => {
    if (!p.countryName) return true;
    return countryMatchesSeed(p.countryName, countryIso2);
  });
}

function countryMatchesSeed(name: string, iso2: string): boolean {
  const seed = FAS_SEED_COUNTRIES.find((c) => c.iso2 === iso2);
  if (!seed) return false;
  const candidates = [seed.name, ...seed.aliases].map((s) => s.toLowerCase());
  return candidates.some((c) => name.toLowerCase().includes(c));
}

async function fetchProjectDocument(
  project: ParsedIfcProject,
): Promise<{ docUrl: string; pdf: Buffer } | null> {
  // Pull the project detail page, find the first PDF link that looks
  // like a disclosure document.
  const html = await fetchHtml(project.projectUrl);
  if (!html) return null;
  const $ = cheerio.load(html);
  const pdfLink = $('a[href$=".pdf"]')
    .filter((_, el) => {
      const href = $(el).attr('href')?.toLowerCase() ?? '';
      const text = $(el).text().toLowerCase();
      return (
        href.includes('disclosure') ||
        text.includes('disclosure') ||
        href.includes('sii') ||
        text.includes('summary of investment') ||
        text.includes('esrs') ||
        text.includes('environmental and social')
      );
    })
    .first();
  const href = pdfLink.attr('href');
  if (!href) return null;
  const docUrl = href.startsWith('http') ? href : `https://disclosures.ifc.org${href}`;

  await new Promise((r) => setTimeout(r, 2000));
  try {
    const resp = await fetch(docUrl, {
      headers: { 'User-Agent': 'procur-mdb-ingest/0.1 (+https://procur.app)' },
    });
    if (!resp.ok) return null;
    const buf = Buffer.from(await resp.arrayBuffer());
    return { docUrl, pdf: buf };
  } catch (err) {
    console.warn(
      `[mdb-ifc] PDF download error for ${project.externalId}: ${(err as Error).message}`,
    );
    return null;
  }
}

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

async function uploadToBlob(externalId: string, pdf: Buffer): Promise<string | null> {
  if (!process.env.BLOB_READ_WRITE_TOKEN) return null;
  try {
    const key = `mdb/ifc/${sha256(pdf).slice(0, 16)}-${externalId}.pdf`;
    const blob = await put(key, pdf, {
      access: 'public',
      contentType: 'application/pdf',
      addRandomSuffix: true,
    });
    return blob.url;
  } catch (err) {
    console.warn(
      `[mdb-ifc] blob upload failed for ${externalId}: ${(err as Error).message}`,
    );
    return null;
  }
}

function normalizeStatus(input: string | null): string | null {
  if (!input) return null;
  const lower = input.toLowerCase();
  if (lower.includes('active') || lower.includes('implementation')) return 'active';
  if (lower.includes('closed') || lower.includes('completed')) return 'closed';
  if (lower.includes('cancel') || lower.includes('drop')) return 'cancelled';
  if (lower.includes('pipeline') || lower.includes('preparation') || lower.includes('pending')) return 'pipeline';
  return lower;
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
  const db = drizzle(neon(process.env.DATABASE_URL), { schema });

  const baseUrl = process.env.MDB_IFC_SEARCH_URL ?? DEFAULT_SEARCH_URL;
  const countriesArg = process.env.MDB_IFC_COUNTRIES?.split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  const seedCountries = countriesArg
    ? FAS_SEED_COUNTRIES.filter((c) => countriesArg.includes(c.iso2))
    : FAS_SEED_COUNTRIES;

  if (seedCountries.length === 0) {
    console.error('[mdb-ifc] MDB_IFC_COUNTRIES filter produced an empty list.');
    process.exit(1);
  }

  console.log(`[mdb-ifc] scraping ${seedCountries.length} countries`);
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    console.log('[mdb-ifc] BLOB_READ_WRITE_TOKEN not set — PDFs will be hashed but not cached.');
  }

  let totalSeen = 0;
  let totalNew = 0;
  let totalPdfsCached = 0;
  let totalSkippedNoDoc = 0;

  for (const country of seedCountries) {
    const searchUrl = `${baseUrl}?country=${encodeURIComponent(country.name)}`;
    console.log(`\n[mdb-ifc] ${country.iso2} (${country.name}) — ${searchUrl}`);

    const html = await fetchHtml(searchUrl);
    if (!html) continue;

    const projects = parseSearchResults(html, country.iso2);
    console.log(`[mdb-ifc]   ${projects.length} projects parsed`);
    totalSeen += projects.length;

    for (const project of projects) {
      let pdfBlobUrl: string | null = null;
      let pdfHash: string | null = null;
      let sourceDocUrl: string | null = null;

      const docResult = await fetchProjectDocument(project);
      if (docResult) {
        sourceDocUrl = docResult.docUrl;
        pdfHash = sha256(docResult.pdf);
        pdfBlobUrl = await uploadToBlob(project.externalId, docResult.pdf);
        if (pdfBlobUrl) totalPdfsCached += 1;
      } else {
        totalSkippedNoDoc += 1;
      }

      const insertResult = await db
        .insert(schema.mdbProjects)
        .values({
          bank: 'ifc',
          externalId: project.externalId,
          countryCode: country.iso2,
          projectName: project.projectName,
          sector: project.sector,
          status: normalizeStatus(project.status),
          approvalDate: project.approvalDate,
          closingDate: null,
          totalAmountUsd: project.totalAmountUsd,
          sourceUrl: project.projectUrl,
          sourceDocUrl,
          pdfBlobUrl,
          pdfSha256: pdfHash,
          pdfPageCount: null,
          rawMetadata: project as unknown as Record<string, unknown>,
        })
        .onConflictDoUpdate({
          target: [schema.mdbProjects.bank, schema.mdbProjects.externalId],
          set: {
            projectName: sql`EXCLUDED.project_name`,
            sector: sql`EXCLUDED.sector`,
            status: sql`EXCLUDED.status`,
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
    `\n[mdb-ifc] done — seen=${totalSeen}, persisted=${totalNew}, pdfs-cached=${totalPdfsCached}, no-doc=${totalSkippedNoDoc}`,
  );
}

main().catch((err) => {
  console.error('[mdb-ifc] FAILED', err);
  process.exit(1);
});
