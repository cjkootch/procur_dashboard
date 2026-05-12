/**
 * Day 2 of gain-extraction-brief.md — operator-facing CLI to validate
 * the parser against cached GAIN PDFs and backfill `pdf_page_count`
 * on rows the Day 1 scraper left null.
 *
 * Prints per-report summary (page count, candidate vs discard section
 * counts). Set GAIN_PARSE_VERBOSE=1 for a per-section listing so you
 * can spot patterns the heuristics miss.
 *
 * The parser library (gain-extraction/parser.ts) is what the Day 3
 * LLM extractor will call programmatically — this CLI is the
 * validation harness for it.
 *
 * Run from repo root:
 *   pnpm --filter @procur/ai parse-gain-reports
 *
 * Env:
 *   DATABASE_URL                # required
 *   GAIN_PARSE_LIMIT=10         # default — number of reports per run
 *   GAIN_PARSE_REPORT_ID=<uuid> # optional — process one specific report
 *   GAIN_PARSE_COUNTRY=VE       # optional — restrict to ISO-2
 *   GAIN_PARSE_VERBOSE=1        # print per-section title + page range
 *   GAIN_PARSE_FORCE=1          # re-parse rows even when pdf_page_count is already set
 */

import 'dotenv/config';
import { config as loadEnv } from 'dotenv';
import { eq, isNull, and } from 'drizzle-orm';
import { db } from '@procur/db/client';
import { gainReports, type GainReport } from '@procur/db';
import { parseGainPdf } from './gain-extraction/parser';

loadEnv({ path: '../../.env.local' });
loadEnv({ path: '../../.env' });

async function fetchPdf(report: GainReport): Promise<Buffer | null> {
  const url = report.pdfBlobUrl ?? report.sourceUrl;
  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'procur-gain-parse/0.1 (+https://procur.app)' },
    });
    if (!resp.ok) {
      console.warn(`  HTTP ${resp.status} fetching ${url}`);
      return null;
    }
    const buf = await resp.arrayBuffer();
    return Buffer.from(buf);
  } catch (err) {
    console.warn(`  fetch error ${url}: ${(err as Error).message}`);
    return null;
  }
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');

  const limit = Number.parseInt(process.env.GAIN_PARSE_LIMIT ?? '10', 10);
  const verbose = process.env.GAIN_PARSE_VERBOSE === '1';
  const force = process.env.GAIN_PARSE_FORCE === '1';
  const reportIdFilter = process.env.GAIN_PARSE_REPORT_ID;
  const countryFilter = process.env.GAIN_PARSE_COUNTRY?.toUpperCase();

  let reports: GainReport[];
  if (reportIdFilter) {
    reports = await db
      .select()
      .from(gainReports)
      .where(eq(gainReports.id, reportIdFilter));
  } else {
    const conditions = [];
    if (!force) conditions.push(isNull(gainReports.pdfPageCount));
    if (countryFilter) conditions.push(eq(gainReports.countryCode, countryFilter));
    const whereClause =
      conditions.length === 0
        ? undefined
        : conditions.length === 1
          ? conditions[0]
          : and(...conditions);
    reports = await db
      .select()
      .from(gainReports)
      .where(whereClause)
      .limit(limit);
  }

  console.log(`[gain-parse] processing ${reports.length} reports`);

  let parsed = 0;
  let fetchFailed = 0;
  let parseFailed = 0;

  for (const r of reports) {
    const pdf = await fetchPdf(r);
    if (!pdf) {
      console.warn(
        `[gain-parse] ${r.countryCode} "${r.title.slice(0, 60)}": fetch failed`,
      );
      fetchFailed += 1;
      continue;
    }
    try {
      const result = await parseGainPdf(pdf);
      const candidateCount = result.sections.filter(
        (s) => s.kind === 'candidate',
      ).length;
      const discardCount = result.sections.filter(
        (s) => s.kind === 'discard',
      ).length;
      console.log(
        `[gain-parse] ${r.countryCode} ${r.reportType.slice(0, 20).padEnd(20)} "${r.title.slice(0, 50)}" — ${result.pageCount}p, ${candidateCount} candidate / ${discardCount} discard sections`,
      );
      if (verbose) {
        for (const s of result.sections) {
          const marker =
            s.kind === 'candidate' ? '✓' : s.kind === 'discard' ? '✗' : '?';
          console.log(
            `    ${marker} p${s.startPage}-${s.endPage}: ${s.title.slice(0, 80)}`,
          );
        }
      }
      await db
        .update(gainReports)
        .set({ pdfPageCount: result.pageCount })
        .where(eq(gainReports.id, r.id));
      parsed += 1;
    } catch (err) {
      console.warn(
        `[gain-parse] ${r.countryCode} "${r.title.slice(0, 60)}": parse failed — ${(err as Error).message}`,
      );
      parseFailed += 1;
    }
  }

  console.log(
    `\n[gain-parse] done — parsed=${parsed}, fetch-failed=${fetchFailed}, parse-failed=${parseFailed}`,
  );
}

main().catch((err) => {
  console.error('[gain-parse] FAILED', err);
  process.exit(1);
});
