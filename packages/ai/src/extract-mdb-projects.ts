/**
 * Day 3 of multilateral-bank-docs-brief.md — drives the full pipeline
 * against mdb_projects rows whose extraction_status='pending':
 *
 *   Fetch PDF → parse (parser.ts) → LLM extract per section →
 *   within-project dedup → INSERT into mdb_entity_mentions →
 *   flip extraction_status.
 *
 * Run from repo root:
 *   pnpm --filter @procur/ai extract-mdb-projects
 *
 * Env:
 *   DATABASE_URL                # required
 *   ANTHROPIC_API_KEY           # required
 *   MDB_EXTRACT_LIMIT=5         # default — projects per run (start tight)
 *   MDB_EXTRACT_PROJECT_ID      # optional — process one specific project
 *   MDB_EXTRACT_BANK=idb        # optional — restrict to one bank
 *   MDB_EXTRACT_COUNTRY=VE      # optional — restrict to ISO-2
 *   MDB_EXTRACT_FORCE=1         # re-extract projects already 'extracted'
 *   MDB_EXTRACT_DRY_RUN=1       # parse + extract, print, do NOT persist
 *   MDB_EXTRACT_TRIAGE=1        # Haiku pre-filter (real-time only)
 *   MDB_EXTRACT_BATCH=1         # Anthropic Batch API (50% off, 24h SLA)
 */

import 'dotenv/config';
import { config as loadEnv } from 'dotenv';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '@procur/db/client';
import {
  mdbProjects,
  mdbEntityMentions,
  type MdbProject,
  type NewMdbEntityMention,
} from '@procur/db';
import { parseMdbPdf, type ParsedMdbDocument } from './mdb-extraction/parser';
import {
  extractMdbProject,
  extractMdbProjectsBatch,
  type MdbExtractionResult,
} from './mdb-extraction/extractor';

loadEnv({ path: '../../.env.local' });
loadEnv({ path: '../../.env' });

type PreparedProject = { project: MdbProject; parsed: ParsedMdbDocument };

async function fetchPdf(project: MdbProject): Promise<Buffer | null> {
  const url = project.pdfBlobUrl ?? project.sourceDocUrl;
  if (!url) return null;
  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'procur-mdb-extract/0.1 (+https://procur.app)' },
    });
    if (!resp.ok) return null;
    return Buffer.from(await resp.arrayBuffer());
  } catch {
    return null;
  }
}

async function prepareProject(project: MdbProject): Promise<PreparedProject | null> {
  console.log(
    `\n[mdb-extract] ${project.bank}/${project.countryCode} "${project.projectName.slice(0, 60)}"`,
  );

  await db
    .update(mdbProjects)
    .set({ extractionAttemptedAt: sql`NOW()` })
    .where(eq(mdbProjects.id, project.id));

  if (!project.sourceDocUrl && !project.pdfBlobUrl) {
    await db
      .update(mdbProjects)
      .set({
        extractionStatus: 'skipped',
        extractionCompletedAt: sql`NOW()`,
        extractionError: 'no_source_document',
      })
      .where(eq(mdbProjects.id, project.id));
    console.log('  · no source doc; skipped');
    return null;
  }

  const pdf = await fetchPdf(project);
  if (!pdf) {
    await db
      .update(mdbProjects)
      .set({ extractionStatus: 'failed', extractionError: 'pdf_fetch_failed' })
      .where(eq(mdbProjects.id, project.id));
    console.warn('  ✗ fetch failed; marked failed');
    return null;
  }

  let parsed: ParsedMdbDocument;
  try {
    parsed = await parseMdbPdf(pdf);
  } catch (err) {
    await db
      .update(mdbProjects)
      .set({
        extractionStatus: 'failed',
        extractionError: `parse_failed: ${(err as Error).message.slice(0, 200)}`,
      })
      .where(eq(mdbProjects.id, project.id));
    console.warn(`  ✗ parse failed: ${(err as Error).message}`);
    return null;
  }

  const candidateCount = parsed.sections.filter((s) => s.kind === 'candidate').length;
  if (candidateCount === 0) {
    await db
      .update(mdbProjects)
      .set({
        extractionStatus: 'skipped',
        extractionCompletedAt: sql`NOW()`,
        extractionError: 'no_candidate_sections',
        pdfPageCount: parsed.pageCount,
      })
      .where(eq(mdbProjects.id, project.id));
    console.log('  · no candidate sections; skipped');
    return null;
  }

  return { project, parsed };
}

async function persistExtraction(
  prepared: PreparedProject,
  result: MdbExtractionResult,
  dryRun: boolean,
) {
  const { project, parsed } = prepared;
  const candidateCount = parsed.sections.filter((s) => s.kind === 'candidate').length;
  const triageSkipped = result.triageDecisions.filter(
    (d) => !d.decision.hasNamedCounterparties,
  ).length;
  console.log(
    `  → ${candidateCount} candidate sections${triageSkipped > 0 ? ` (${triageSkipped} skipped by triage)` : ''}, ${result.entities.length} entities extracted (after dedup)`,
  );
  console.log(
    `  → tokens: input=${result.usage.inputTokens}, output=${result.usage.outputTokens}, cache_read=${result.usage.cacheReadTokens}`,
  );
  for (const e of result.entities) {
    const value = e.contractValueUsd != null ? ` $${e.contractValueUsd.toLocaleString()}` : '';
    console.log(
      `    • ${e.companyName} [${e.roles.join(',')}] ${e.sector}${value} (conf=${e.extractionConfidence.toFixed(2)})`,
    );
  }

  if (dryRun) {
    console.log('  · dry-run: not persisting');
    return;
  }

  if (result.entities.length > 0) {
    const rows: NewMdbEntityMention[] = result.entities.map((e) => ({
      projectId: project.id,
      companyName: e.companyName,
      companyNameNormalized: e.companyNameNormalized,
      roles: e.roles,
      sector: e.sector,
      contractValueUsd: e.contractValueUsd != null ? String(e.contractValueUsd) : null,
      contextExcerpt: e.contextExcerpt,
      sourceSection: e.sourceSection,
      sourcePage: e.sourcePage,
      extractionConfidence: String(e.extractionConfidence),
    }));
    await db.insert(mdbEntityMentions).values(rows);
  }

  await db
    .update(mdbProjects)
    .set({
      extractionStatus: 'extracted',
      extractionCompletedAt: sql`NOW()`,
      extractionError: null,
      pdfPageCount: parsed.pageCount,
    })
    .where(eq(mdbProjects.id, project.id));
}

async function processProjectRealtime(
  project: MdbProject,
  dryRun: boolean,
  triage: boolean,
) {
  const prepared = await prepareProject(project);
  if (!prepared) return;

  let result: MdbExtractionResult;
  try {
    result = await extractMdbProject({
      parsed: prepared.parsed,
      projectName: project.projectName,
      bank: project.bank,
      countryCode: project.countryCode,
      triage,
    });
  } catch (err) {
    await db
      .update(mdbProjects)
      .set({
        extractionStatus: 'failed',
        extractionError: `llm_failed: ${(err as Error).message.slice(0, 200)}`,
      })
      .where(eq(mdbProjects.id, project.id));
    console.warn(`  ✗ LLM extract failed: ${(err as Error).message}`);
    return;
  }
  await persistExtraction(prepared, result, dryRun);
}

async function processProjectsBatch(projects: MdbProject[], dryRun: boolean) {
  console.log(`[mdb-extract] batch mode — preparing ${projects.length} projects`);

  const prepared: PreparedProject[] = [];
  for (const project of projects) {
    const p = await prepareProject(project);
    if (p) prepared.push(p);
  }
  if (prepared.length === 0) {
    console.log('[mdb-extract] no projects ready for batch (all terminal); done');
    return;
  }

  console.log(
    `\n[mdb-extract] submitting batch for ${prepared.length} projects — wait time can range from minutes to ~24h`,
  );

  const batchResult = await extractMdbProjectsBatch(
    prepared.map((p) => ({
      projectId: p.project.id,
      projectName: p.project.projectName,
      bank: p.project.bank,
      countryCode: p.project.countryCode,
      parsed: p.parsed,
    })),
    {
      onStatus: (status) => {
        const counts = status.request_counts;
        const completed = counts.succeeded + counts.errored + counts.canceled + counts.expired;
        const total = completed + counts.processing;
        console.log(
          `  · batch ${status.id} status=${status.processing_status} processed=${completed}/${total}`,
        );
      },
    },
  );

  for (const p of prepared) {
    const r = batchResult.byProject.get(p.project.id);
    if (r) {
      await persistExtraction(p, r, dryRun);
      continue;
    }
    await db
      .update(mdbProjects)
      .set({ extractionStatus: 'failed', extractionError: 'batch_no_results' })
      .where(eq(mdbProjects.id, p.project.id));
    console.warn(
      `  ✗ ${p.project.bank}/${p.project.countryCode} ${p.project.projectName.slice(0, 40)}: no batch results`,
    );
  }

  if (batchResult.errors.size > 0) {
    console.log(`\n[mdb-extract] batch errors:`);
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

  const limit = Number.parseInt(process.env.MDB_EXTRACT_LIMIT ?? '5', 10);
  const force = process.env.MDB_EXTRACT_FORCE === '1';
  const dryRun = process.env.MDB_EXTRACT_DRY_RUN === '1';
  const triage = process.env.MDB_EXTRACT_TRIAGE === '1';
  const useBatch = process.env.MDB_EXTRACT_BATCH === '1';
  const projectIdFilter = process.env.MDB_EXTRACT_PROJECT_ID;
  const bankFilter = process.env.MDB_EXTRACT_BANK?.toLowerCase();
  const countryFilter = process.env.MDB_EXTRACT_COUNTRY?.toUpperCase();

  let projects: MdbProject[];
  if (projectIdFilter) {
    projects = await db
      .select()
      .from(mdbProjects)
      .where(eq(mdbProjects.id, projectIdFilter));
  } else {
    const conditions = [];
    if (!force) conditions.push(eq(mdbProjects.extractionStatus, 'pending'));
    if (bankFilter) conditions.push(eq(mdbProjects.bank, bankFilter));
    if (countryFilter) conditions.push(eq(mdbProjects.countryCode, countryFilter));
    const whereClause =
      conditions.length === 0
        ? undefined
        : conditions.length === 1
          ? conditions[0]
          : and(...conditions);
    projects = await db
      .select()
      .from(mdbProjects)
      .where(whereClause)
      .limit(limit);
  }

  console.log(
    `[mdb-extract] processing ${projects.length} projects (mode=${useBatch ? 'batch' : 'realtime'}, triage=${triage && !useBatch}, dry-run=${dryRun})`,
  );

  if (useBatch && triage) {
    console.log(
      '[mdb-extract] note: MDB_EXTRACT_TRIAGE is ignored in batch mode (every section goes to Sonnet at 50%-off batch rate).',
    );
  }

  if (useBatch) {
    await processProjectsBatch(projects, dryRun);
  } else {
    for (const p of projects) {
      await processProjectRealtime(p, dryRun, triage);
    }
  }

  console.log('\n[mdb-extract] done');
}

main().catch((err) => {
  console.error('[mdb-extract] FAILED', err);
  process.exit(1);
});
