/**
 * Day 3 of gain-extraction-brief.md — drives the full pipeline against
 * gain_reports rows whose extraction_status='pending':
 *
 *   Fetch PDF → parse (Day 2) → LLM extract per section → within-report
 *   dedup → INSERT into gain_importer_mentions → flip extraction_status.
 *
 * Cost / token expectations per brief §4.4:
 *   - ~$0.15-0.25 / report on Sonnet
 *   - 200-report backfill: ~$30-50
 *   - Quarterly delta: ~$5-10
 *
 * Run from repo root:
 *   pnpm --filter @procur/ai extract-gain-reports
 *
 * Env:
 *   DATABASE_URL                # required
 *   ANTHROPIC_API_KEY           # required
 *   GAIN_EXTRACT_LIMIT=5        # default — reports per run (start tight)
 *   GAIN_EXTRACT_REPORT_ID      # optional — process one specific report
 *   GAIN_EXTRACT_COUNTRY=VE     # optional — restrict to ISO-2
 *   GAIN_EXTRACT_FORCE=1        # re-extract reports already marked 'extracted'
 *   GAIN_EXTRACT_DRY_RUN=1      # parse + extract, print results, do NOT persist
 */

import 'dotenv/config';
import { config as loadEnv } from 'dotenv';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '@procur/db/client';
import {
  gainReports,
  gainImporterMentions,
  type GainReport,
  type NewGainImporterMention,
} from '@procur/db';
import { parseGainPdf } from './gain-extraction/parser';
import { extractGainReport } from './gain-extraction/extractor';

loadEnv({ path: '../../.env.local' });
loadEnv({ path: '../../.env' });

async function fetchPdf(report: GainReport): Promise<Buffer | null> {
  const url = report.pdfBlobUrl ?? report.sourceUrl;
  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'procur-gain-extract/0.1 (+https://procur.app)' },
    });
    if (!resp.ok) return null;
    const buf = await resp.arrayBuffer();
    return Buffer.from(buf);
  } catch {
    return null;
  }
}

async function processReport(report: GainReport, dryRun: boolean) {
  console.log(
    `\n[gain-extract] ${report.countryCode} ${report.reportType} "${report.title.slice(0, 60)}"`,
  );

  await db
    .update(gainReports)
    .set({ extractionAttemptedAt: sql`NOW()` })
    .where(eq(gainReports.id, report.id));

  const pdf = await fetchPdf(report);
  if (!pdf) {
    await db
      .update(gainReports)
      .set({
        extractionStatus: 'failed',
        extractionError: 'pdf_fetch_failed',
      })
      .where(eq(gainReports.id, report.id));
    console.warn('  ✗ fetch failed; marked failed');
    return;
  }

  let parsed;
  try {
    parsed = await parseGainPdf(pdf);
  } catch (err) {
    await db
      .update(gainReports)
      .set({
        extractionStatus: 'failed',
        extractionError: `parse_failed: ${(err as Error).message.slice(0, 200)}`,
      })
      .where(eq(gainReports.id, report.id));
    console.warn(`  ✗ parse failed: ${(err as Error).message}`);
    return;
  }

  const candidateCount = parsed.sections.filter((s) => s.kind === 'candidate').length;
  if (candidateCount === 0) {
    await db
      .update(gainReports)
      .set({
        extractionStatus: 'skipped',
        extractionCompletedAt: sql`NOW()`,
        extractionError: 'no_candidate_sections',
        pdfPageCount: parsed.pageCount,
      })
      .where(eq(gainReports.id, report.id));
    console.log('  · no candidate sections; skipped');
    return;
  }

  let result;
  try {
    result = await extractGainReport({
      parsed,
      reportTitle: report.title,
      reportType: report.reportType,
      countryCode: report.countryCode,
    });
  } catch (err) {
    await db
      .update(gainReports)
      .set({
        extractionStatus: 'failed',
        extractionError: `llm_failed: ${(err as Error).message.slice(0, 200)}`,
      })
      .where(eq(gainReports.id, report.id));
    console.warn(`  ✗ LLM extract failed: ${(err as Error).message}`);
    return;
  }

  console.log(
    `  → ${candidateCount} candidate sections, ${result.importers.length} importers extracted (after dedup)`,
  );
  console.log(
    `  → tokens: input=${result.usage.inputTokens}, output=${result.usage.outputTokens}, cache_read=${result.usage.cacheReadTokens}`,
  );
  for (const imp of result.importers) {
    console.log(
      `    • ${imp.companyName} [${imp.roles.join(',')}] ${imp.commodityCategories.join('/')} (${imp.marketPosition}, conf=${imp.extractionConfidence.toFixed(2)})`,
    );
  }

  if (dryRun) {
    console.log('  · dry-run: not persisting');
    return;
  }

  if (result.importers.length > 0) {
    const rows: NewGainImporterMention[] = result.importers.map((imp) => ({
      reportId: report.id,
      companyName: imp.companyName,
      companyNameNormalized: imp.companyNameNormalized,
      roles: imp.roles,
      commodityCategories: imp.commodityCategories,
      marketPosition: imp.marketPosition,
      supplyPreferences: imp.supplyPreferences,
      contextExcerpt: imp.contextExcerpt,
      sourceSection: imp.sourceSection,
      sourcePage: imp.sourcePage,
      extractionConfidence: String(imp.extractionConfidence),
    }));
    await db.insert(gainImporterMentions).values(rows);
  }

  await db
    .update(gainReports)
    .set({
      extractionStatus: 'extracted',
      extractionCompletedAt: sql`NOW()`,
      extractionError: null,
      pdfPageCount: parsed.pageCount,
    })
    .where(eq(gainReports.id, report.id));
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY is required.');
  }

  const limit = Number.parseInt(process.env.GAIN_EXTRACT_LIMIT ?? '5', 10);
  const force = process.env.GAIN_EXTRACT_FORCE === '1';
  const dryRun = process.env.GAIN_EXTRACT_DRY_RUN === '1';
  const reportIdFilter = process.env.GAIN_EXTRACT_REPORT_ID;
  const countryFilter = process.env.GAIN_EXTRACT_COUNTRY?.toUpperCase();

  let reports: GainReport[];
  if (reportIdFilter) {
    reports = await db
      .select()
      .from(gainReports)
      .where(eq(gainReports.id, reportIdFilter));
  } else {
    const conditions = [];
    if (!force) conditions.push(eq(gainReports.extractionStatus, 'pending'));
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

  console.log(
    `[gain-extract] processing ${reports.length} reports (dry-run=${dryRun})`,
  );

  for (const r of reports) {
    await processReport(r, dryRun);
  }

  console.log('\n[gain-extract] done');
}

main().catch((err) => {
  console.error('[gain-extract] FAILED', err);
  process.exit(1);
});
