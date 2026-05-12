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
 *   GAIN_EXTRACT_TRIAGE=1       # pre-filter sections with Haiku before Sonnet (real-time mode only)
 *   GAIN_EXTRACT_BATCH=1        # submit via Anthropic Batch API (50% off, ~minutes-to-24h wall clock)
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
import { parseGainPdf, type ParsedGainReport } from './gain-extraction/parser';
import {
  extractGainReport,
  extractGainReportsBatch,
  type GainExtractionResult,
} from './gain-extraction/extractor';

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

type PreparedReport = { report: GainReport; parsed: ParsedGainReport };

/**
 * Fetch + parse + handle terminal cases (fetch failed / parse failed /
 * no candidate sections). Returns the parsed report when extraction
 * should proceed; null when terminal state was already persisted.
 */
async function prepareReport(report: GainReport): Promise<PreparedReport | null> {
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
      .set({ extractionStatus: 'failed', extractionError: 'pdf_fetch_failed' })
      .where(eq(gainReports.id, report.id));
    console.warn('  ✗ fetch failed; marked failed');
    return null;
  }

  let parsed: ParsedGainReport;
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
    return null;
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
    return null;
  }

  return { report, parsed };
}

async function persistExtraction(
  prepared: PreparedReport,
  result: GainExtractionResult,
  dryRun: boolean,
) {
  const { report, parsed } = prepared;
  const candidateCount = parsed.sections.filter((s) => s.kind === 'candidate').length;
  const triageSkipped = result.triageDecisions.filter(
    (d) => !d.decision.hasNamedImporters,
  ).length;
  console.log(
    `  → ${candidateCount} candidate sections${triageSkipped > 0 ? ` (${triageSkipped} skipped by triage)` : ''}, ${result.importers.length} importers extracted (after dedup)`,
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

async function processReportRealtime(
  report: GainReport,
  dryRun: boolean,
  triage: boolean,
) {
  const prepared = await prepareReport(report);
  if (!prepared) return;

  let result: GainExtractionResult;
  try {
    result = await extractGainReport({
      parsed: prepared.parsed,
      reportTitle: report.title,
      reportType: report.reportType,
      countryCode: report.countryCode,
      triage,
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
  await persistExtraction(prepared, result, dryRun);
}

async function processReportsBatch(reports: GainReport[], dryRun: boolean) {
  console.log(`[gain-extract] batch mode — preparing ${reports.length} reports`);

  const prepared: PreparedReport[] = [];
  for (const report of reports) {
    const p = await prepareReport(report);
    if (p) prepared.push(p);
  }
  if (prepared.length === 0) {
    console.log('[gain-extract] no reports ready for batch (all terminal); done');
    return;
  }

  console.log(
    `\n[gain-extract] submitting batch for ${prepared.length} reports — wait time can range from minutes to ~24h`,
  );

  const batchResult = await extractGainReportsBatch(
    prepared.map((p) => ({
      reportId: p.report.id,
      reportTitle: p.report.title,
      reportType: p.report.reportType,
      countryCode: p.report.countryCode,
      parsed: p.parsed,
    })),
    {
      onStatus: (status) => {
        console.log(
          `  · batch ${status.id} status=${status.processing_status} processed=${status.request_counts.succeeded + status.request_counts.errored + status.request_counts.canceled + status.request_counts.expired}/${status.request_counts.processing + status.request_counts.succeeded + status.request_counts.errored + status.request_counts.canceled + status.request_counts.expired}`,
        );
      },
    },
  );

  for (const p of prepared) {
    const r = batchResult.byReport.get(p.report.id);
    if (r) {
      await persistExtraction(p, r, dryRun);
      continue;
    }
    await db
      .update(gainReports)
      .set({
        extractionStatus: 'failed',
        extractionError: 'batch_no_results',
      })
      .where(eq(gainReports.id, p.report.id));
    console.warn(`  ✗ ${p.report.countryCode} ${p.report.title.slice(0, 40)}: no batch results`);
  }

  if (batchResult.errors.size > 0) {
    console.log(`\n[gain-extract] batch errors:`);
    for (const [customId, err] of batchResult.errors) {
      console.log(`  ${customId}: ${err}`);
    }
  }
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY is required.');
  }

  const limit = Number.parseInt(process.env.GAIN_EXTRACT_LIMIT ?? '5', 10);
  const force = process.env.GAIN_EXTRACT_FORCE === '1';
  const dryRun = process.env.GAIN_EXTRACT_DRY_RUN === '1';
  const triage = process.env.GAIN_EXTRACT_TRIAGE === '1';
  const useBatch = process.env.GAIN_EXTRACT_BATCH === '1';
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
    `[gain-extract] processing ${reports.length} reports (mode=${useBatch ? 'batch' : 'realtime'}, triage=${triage && !useBatch}, dry-run=${dryRun})`,
  );

  if (useBatch && triage) {
    console.log(
      '[gain-extract] note: GAIN_EXTRACT_TRIAGE is ignored in batch mode (every section goes to Sonnet at 50%-off batch rate).',
    );
  }

  if (useBatch) {
    await processReportsBatch(reports, dryRun);
  } else {
    for (const r of reports) {
      await processReportRealtime(r, dryRun, triage);
    }
  }

  console.log('\n[gain-extract] done');
}

main().catch((err) => {
  console.error('[gain-extract] FAILED', err);
  process.exit(1);
});
