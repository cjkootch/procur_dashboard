/**
 * Caribbean Development Bank (CDB) project ingest — Day 2 of
 * multilateral-bank-docs-brief.md.
 *
 * CDB is CARICOM-only (~$700M annual lending) and has NO public API.
 * Project + contract-award data lives in HTML at caribank.org.
 * This scraper targets the contract-awards page which names
 * contractors directly — highest operator value of the CDB surfaces.
 *
 * Smaller scope than IDB / World Bank: ~150 active projects total
 * across CARICOM, but CDB is the ONLY source naming contractors for
 * Bahamas / Barbados / Antigua / Grenada / Dominica work — closes a
 * gap the larger banks don't reach.
 *
 * Polite-crawler: 2s delay between requests; respects robots.txt
 * conventionally. No rate-limit headers documented; conservative.
 *
 * Idempotent on (bank='cdb', external_id) where external_id is the
 * contract reference when available, otherwise a stable hash of the
 * row content (so the same award doesn't duplicate across re-runs).
 *
 * Run from repo root:
 *   pnpm --filter @procur/db ingest-mdb-cdb
 *
 * Env:
 *   DATABASE_URL                  # required
 *   MDB_CDB_COUNTRIES=JM,BS,BB    # optional — filter CARICOM-side seeds
 *   MDB_CDB_AWARDS_URL=...        # optional override for testing
 */
import 'dotenv/config';
import { config as loadEnv } from 'dotenv';
import { createHash } from 'node:crypto';
import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import { sql } from 'drizzle-orm';
import * as cheerio from 'cheerio';
import * as schema from './schema';
import { FAS_SEED_COUNTRIES } from './lib/fas-seed-countries';

loadEnv({ path: '../../.env.local' });
loadEnv({ path: '../../.env' });

const DEFAULT_AWARDS_URL =
  'https://www.caribank.org/work-with-us/procurement/contract-awards';

/**
 * Best-effort parser for the CDB contract-awards table. The CDB site
 * uses Drupal-rendered tables; column layout is stable but cell order
 * varies by year. We extract cells by header text rather than fixed
 * position so a column reorder doesn't silently corrupt data.
 */
interface ParsedAward {
  countryName: string | null;
  projectName: string | null;
  contractorName: string | null;
  contractRef: string | null;
  amount: string | null;
  awardDate: string | null;
  contractUrl: string | null;
}

async function fetchAwardsPage(url: string): Promise<string | null> {
  await new Promise((r) => setTimeout(r, 2000)); // polite-crawler delay
  try {
    const resp = await fetch(url, {
      headers: {
        Accept: 'text/html',
        'User-Agent': 'procur-mdb-ingest/0.1 (+https://procur.app)',
      },
    });
    if (!resp.ok) {
      console.warn(`[mdb-cdb] HTTP ${resp.status} for ${url}`);
      return null;
    }
    return await resp.text();
  } catch (err) {
    console.warn(`[mdb-cdb] fetch error: ${(err as Error).message}`);
    return null;
  }
}

function normalizeHeader(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ').replace(/[^a-z0-9 ]/g, '');
}

function parseAwardsTable(html: string): ParsedAward[] {
  const $ = cheerio.load(html);
  const awards: ParsedAward[] = [];

  // CDB renders awards inside <table> elements; some pages embed
  // multiple tables (by year). Walk each, identify the header row, map
  // columns by name, then iterate body rows.
  $('table').each((_, table) => {
    const headerRow = $(table).find('thead tr').first().length
      ? $(table).find('thead tr').first()
      : $(table).find('tr').first();
    const headers: string[] = [];
    headerRow.find('th, td').each((_, cell) => {
      headers.push(normalizeHeader($(cell).text()));
    });
    if (headers.length === 0) return;

    const colIdx = (...candidates: string[]): number => {
      for (const c of candidates) {
        const idx = headers.findIndex((h) => h.includes(c));
        if (idx >= 0) return idx;
      }
      return -1;
    };
    const ICountry = colIdx('country', 'borrower country');
    const IProject = colIdx('project', 'project name');
    const IContractor = colIdx('contractor', 'awardee', 'supplier');
    const IRef = colIdx('contract no', 'contract reference', 'reference', 'ref');
    const IAmount = colIdx('amount', 'value', 'contract amount');
    const IDate = colIdx('award date', 'date of award', 'date');

    const bodyRows =
      $(table).find('tbody tr').length > 0
        ? $(table).find('tbody tr')
        : $(table).find('tr').slice(1);

    bodyRows.each((_, row) => {
      const cells = $(row).find('td');
      if (cells.length === 0) return;
      const cellText = (i: number): string | null =>
        i >= 0 ? $(cells[i]).text().trim() || null : null;
      const cellHref = (i: number): string | null => {
        if (i < 0) return null;
        const a = $(cells[i]).find('a').first();
        return a.attr('href') || null;
      };

      const award: ParsedAward = {
        countryName: cellText(ICountry),
        projectName: cellText(IProject),
        contractorName: cellText(IContractor),
        contractRef: cellText(IRef),
        amount: cellText(IAmount),
        awardDate: cellText(IDate),
        contractUrl: cellHref(IProject) ?? cellHref(IRef),
      };
      // Skip rows that have nothing meaningful — heuristic to drop
      // table headers / summary rows.
      if (!award.contractorName && !award.projectName) return;
      awards.push(award);
    });
  });

  return awards;
}

function parseAmountToUsd(input: string | null): string | null {
  if (!input) return null;
  // Strip currency symbols + commas; CDB publishes most amounts in
  // USD but occasionally in local currency. We persist the raw text
  // in raw_metadata; numeric column gets the parsed value when sane.
  const cleaned = input.replace(/[^0-9.]/g, '');
  if (!cleaned) return null;
  const n = Number.parseFloat(cleaned);
  if (!Number.isFinite(n) || n <= 0) return null;
  return String(n);
}

function parseDate(input: string | null): string | null {
  if (!input) return null;
  const trimmed = input.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(trimmed);
  if (iso?.[1] && iso[2] && iso[3]) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  // CDB sometimes uses "DD Month YYYY".
  const longForm =
    /^(\d{1,2})\s+(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{4})$/i.exec(
      trimmed,
    );
  if (longForm) {
    const day = longForm[1]?.padStart(2, '0');
    const year = longForm[3];
    const monthMap: Record<string, string> = {
      jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
      jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
    };
    const monthKey = longForm[2]?.toLowerCase().slice(0, 3);
    const mm = monthKey ? monthMap[monthKey] : undefined;
    if (day && year && mm) return `${year}-${mm}-${day}`;
  }
  return null;
}

function resolveCountry(name: string | null): string | null {
  if (!name) return null;
  const cleaned = name.trim().toLowerCase();
  const seed = FAS_SEED_COUNTRIES.find(
    (c) =>
      c.name.toLowerCase() === cleaned ||
      c.aliases.some((a) => a.toLowerCase() === cleaned),
  );
  if (seed) return seed.iso2;
  // CDB regularly uses CARICOM short names not in our seed list yet
  // (BS Bahamas, BB Barbados, AG Antigua and Barbuda, GD Grenada,
  // DM Dominica, KN St Kitts and Nevis, LC St Lucia, VC St Vincent and
  // the Grenadines, BZ Belize, AI Anguilla, MS Montserrat, KY Cayman
  // Islands, TC Turks and Caicos, VG British Virgin Islands).
  const caricomLookup: Record<string, string> = {
    'the bahamas': 'BS', 'bahamas': 'BS',
    'barbados': 'BB',
    'antigua and barbuda': 'AG', 'antigua & barbuda': 'AG', 'antigua': 'AG',
    'grenada': 'GD',
    'dominica': 'DM', 'commonwealth of dominica': 'DM',
    'saint kitts and nevis': 'KN', 'st kitts and nevis': 'KN', 'st. kitts and nevis': 'KN',
    'saint lucia': 'LC', 'st lucia': 'LC', 'st. lucia': 'LC',
    'saint vincent and the grenadines': 'VC', 'st vincent and the grenadines': 'VC',
    'belize': 'BZ',
    'anguilla': 'AI',
    'montserrat': 'MS',
    'cayman islands': 'KY',
    'turks and caicos': 'TC', 'turks and caicos islands': 'TC',
    'british virgin islands': 'VG',
    'guyana': 'GY',
    'jamaica': 'JM',
    'trinidad and tobago': 'TT', 'trinidad & tobago': 'TT',
    'suriname': 'SR',
    'haiti': 'HT',
  };
  return caricomLookup[cleaned] ?? null;
}

function buildExternalId(award: ParsedAward, countryCode: string): string {
  // Prefer contract reference; fall back to a deterministic hash of
  // country + project + contractor + date so re-running doesn't
  // duplicate rows.
  if (award.contractRef) return `${countryCode}/${award.contractRef}`;
  const hashInput = [
    countryCode,
    award.projectName ?? '',
    award.contractorName ?? '',
    award.awardDate ?? '',
    award.amount ?? '',
  ].join('|');
  const hash = createHash('sha256').update(hashInput).digest('hex').slice(0, 12);
  return `${countryCode}/sha-${hash}`;
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
  const db = drizzle(neon(process.env.DATABASE_URL), { schema });

  const awardsUrl = process.env.MDB_CDB_AWARDS_URL ?? DEFAULT_AWARDS_URL;
  const countriesArg = process.env.MDB_CDB_COUNTRIES?.split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);

  console.log(`[mdb-cdb] fetching ${awardsUrl}`);
  const html = await fetchAwardsPage(awardsUrl);
  if (!html) {
    console.error('[mdb-cdb] no HTML; exiting');
    process.exit(1);
  }

  const awards = parseAwardsTable(html);
  console.log(`[mdb-cdb] parsed ${awards.length} award rows`);

  let totalNew = 0;
  let totalUnresolvedCountry = 0;
  let totalFiltered = 0;

  for (const award of awards) {
    const countryCode = resolveCountry(award.countryName);
    if (!countryCode) {
      totalUnresolvedCountry += 1;
      continue;
    }
    if (countriesArg && !countriesArg.includes(countryCode)) {
      totalFiltered += 1;
      continue;
    }

    const externalId = buildExternalId(award, countryCode);
    const insertResult = await db
      .insert(schema.mdbProjects)
      .values({
        bank: 'cdb',
        externalId,
        countryCode,
        projectName: award.projectName ?? award.contractorName ?? externalId,
        sector: null, // CDB awards table doesn't expose sector directly
        status: 'active', // contract-award page lists active awards
        approvalDate: parseDate(award.awardDate),
        closingDate: null,
        totalAmountUsd: parseAmountToUsd(award.amount),
        sourceUrl: awardsUrl,
        sourceDocUrl: award.contractUrl
          ? award.contractUrl.startsWith('http')
            ? award.contractUrl
            : `https://www.caribank.org${award.contractUrl}`
          : null,
        pdfBlobUrl: null,
        pdfSha256: null,
        pdfPageCount: null,
        rawMetadata: award as unknown as Record<string, unknown>,
      })
      .onConflictDoUpdate({
        target: [schema.mdbProjects.bank, schema.mdbProjects.externalId],
        set: {
          projectName: sql`EXCLUDED.project_name`,
          status: sql`EXCLUDED.status`,
          approvalDate: sql`EXCLUDED.approval_date`,
          totalAmountUsd: sql`EXCLUDED.total_amount_usd`,
          sourceDocUrl: sql`EXCLUDED.source_doc_url`,
          rawMetadata: sql`EXCLUDED.raw_metadata`,
        },
      })
      .returning({ id: schema.mdbProjects.id });

    if (insertResult.length > 0) totalNew += 1;
  }

  console.log(
    `\n[mdb-cdb] done — parsed=${awards.length}, persisted=${totalNew}, unresolved-country=${totalUnresolvedCountry}, filtered=${totalFiltered}`,
  );
  if (totalUnresolvedCountry > 0) {
    console.log(
      `[mdb-cdb] tip: ${totalUnresolvedCountry} rows had country names that didn't resolve. Extend caricomLookup in ingest-mdb-cdb.ts if these are real seeds.`,
    );
  }
}

main().catch((err) => {
  console.error('[mdb-cdb] FAILED', err);
  process.exit(1);
});
