/**
 * NI 43-101 mining technical report ingest.
 *
 * Source: SEDAR+ (sedarplus.ca) — Canadian regulatory filings for
 * mineral projects on TSX, TSX-V. Required for material disclosures;
 * filed under regulatory liability. See
 * buyer-intelligence-v2-free-sources-brief.md §4.3.
 *
 * This script is the file-path-driven version (analyst downloads
 * PDFs from SEDAR+ and runs the script per-report). A SEDAR+
 * scraper for automated batch download is a follow-up — same shape
 * as ingest-eu-mrv (path arg), so runs alongside.
 *
 * Pipeline:
 *   1. Read PDF via unpdf → plain text (Sonnet 4.6 1M context handles
 *      even 400+ page reports without chunking)
 *   2. Sonnet structured extraction via extractNI43101 task
 *   3. Match operator + project name against known_entities via
 *      pg_trgm similarity. If no match → log + skip (don't auto-
 *      create entities from extracted data — fabrication risk).
 *   4. Choose best derivation path for bbl/yr range:
 *        a) Direct annual_diesel_kl → 0.90 confidence
 *        b) fuel_cost_usd_yr ÷ benchmark diesel price → 0.65
 *        c) annual_production × intensity_factor → 0.55
 *   5. Insert signal at source='ni_43_101', signal_kind='volume_estimate'
 *      (or 'expenditure_signal' for path b). Idempotent on
 *      (entity_slug, source, coverage_year).
 *
 * Run from repo root:
 *   pnpm --filter @procur/ai ingest-ni-43-101 <path-to-report.pdf>
 *   pnpm --filter @procur/ai ingest-ni-43-101 <path> --dry-run
 *   pnpm --filter @procur/ai ingest-ni-43-101 <path> --year=2024
 */
import 'dotenv/config';
import { config as loadEnv } from 'dotenv';
import { readFile } from 'node:fs/promises';
import { resolve, isAbsolute } from 'node:path';
import { sql } from 'drizzle-orm';
import { extractText as unpdfExtract, getDocumentProxy } from 'unpdf';
import { db } from '@procur/db/client';
import { extractNI43101, type NI43101OutputT } from './tasks/extract-ni-43-101';

loadEnv({ path: '../../.env.local' });
loadEnv({ path: '../../.env' });

const L_PER_BBL = 158.987;
// Benchmark diesel prices (USD/bbl) for the expenditure→volume
// fallback. Bracketed to express the 12-month band — actual signal
// uses the band as min/max. ULSD USGC averaged ~$95-130/bbl 2023-25;
// remote mining sites pay a logistics premium pushing landed cost
// higher (~$140-200/bbl Caribbean / Suriname / Guyana interior).
const DIESEL_USD_PER_BBL_MIN = 130;
const DIESEL_USD_PER_BBL_MAX = 200;

type DerivationPath = 'direct_volume' | 'opex_derived' | 'production_derived' | 'none';

type SignalDraft = {
  entitySlug: string;
  entityName: string;
  derivation: DerivationPath;
  bblYrMin: number;
  bblYrMax: number;
  confidence: number;
  signalKind: 'volume_estimate' | 'expenditure_signal';
  fuelType: 'diesel' | 'hfo' | 'mixed' | null;
  coverageYear: number;
  notes: string;
  rawData: Record<string, unknown>;
};

function resolveUserPath(p: string): string {
  if (isAbsolute(p)) return p;
  const baseDir = process.env.INIT_CWD ?? process.cwd();
  return resolve(baseDir, p);
}

async function readPdfText(path: string): Promise<{ text: string; pageCount: number }> {
  const buf = await readFile(path);
  const pdf = await getDocumentProxy(new Uint8Array(buf));
  const { text } = await unpdfExtract(pdf, { mergePages: true });
  return {
    text: Array.isArray(text) ? text.join('\n\n') : text,
    pageCount: pdf.numPages,
  };
}

/**
 * Match an operator name + project name to an existing
 * known_entities row via pg_trgm. Returns the best match above the
 * threshold, or null. We prefer project-name match (more specific)
 * over operator-name match, mirroring procur's slug convention
 * `fuel-buyer:<operator>-<project>`.
 */
async function matchKnownEntity(
  operatorName: string,
  projectName: string,
): Promise<{ slug: string; name: string; matchedBy: 'project' | 'operator' } | null> {
  const projectMatch = (await db.execute(sql`
    SELECT slug, name, similarity(name, ${projectName}) AS score
      FROM known_entities
     WHERE similarity(name, ${projectName}) > 0.45
     ORDER BY score DESC
     LIMIT 1;
  `)).rows as unknown as Array<{ slug: string; name: string; score: number }>;
  if (projectMatch.length > 0 && projectMatch[0]) {
    return { slug: projectMatch[0].slug, name: projectMatch[0].name, matchedBy: 'project' };
  }
  const operatorMatch = (await db.execute(sql`
    SELECT slug, name, similarity(name, ${operatorName}) AS score
      FROM known_entities
     WHERE similarity(name, ${operatorName}) > 0.55
     ORDER BY score DESC
     LIMIT 1;
  `)).rows as unknown as Array<{ slug: string; name: string; score: number }>;
  if (operatorMatch.length > 0 && operatorMatch[0]) {
    return { slug: operatorMatch[0].slug, name: operatorMatch[0].name, matchedBy: 'operator' };
  }
  return null;
}

function pickFuelType(extracted: NI43101OutputT['fuelConsumption']): 'diesel' | 'hfo' | 'mixed' | null {
  if (!extracted) return null;
  const hasDiesel = extracted.annualDieselKilolitres != null && extracted.annualDieselKilolitres > 0;
  const hasHfo = extracted.annualHfoKilolitres != null && extracted.annualHfoKilolitres > 0;
  if (hasDiesel && hasHfo) return 'mixed';
  if (hasHfo) return 'hfo';
  if (hasDiesel) return 'diesel';
  return null;
}

function bblFromKl(kl: number): number {
  return (kl * 1000) / L_PER_BBL;
}

/**
 * Apply the derivation logic from the brief.  Returns null when the
 * extracted data has nothing fuel-relevant.
 */
function deriveSignal(
  ex: NI43101OutputT,
  match: { slug: string; name: string },
  coverageYear: number,
): SignalDraft | null {
  const fc = ex.fuelConsumption;

  // Path 1: direct fuel volume (highest confidence)
  const dieselKl = fc.annualDieselKilolitres ?? 0;
  const hfoKl = fc.annualHfoKilolitres ?? 0;
  if (dieselKl > 0 || hfoKl > 0) {
    const bblMid = bblFromKl(dieselKl + hfoKl);
    // ±15% band on direct-volume disclosures (NI 43-101 fuel
    // projections are usually point estimates without disclosed
    // ranges — we widen by 15% to acknowledge actual-vs-projected drift).
    return {
      entitySlug: match.slug,
      entityName: match.name,
      derivation: 'direct_volume',
      bblYrMin: bblMid * 0.85,
      bblYrMax: bblMid * 1.15,
      confidence: 0.9,
      signalKind: 'volume_estimate',
      fuelType: pickFuelType(fc),
      coverageYear,
      notes: `NI 43-101: direct disclosure ${dieselKl > 0 ? `${dieselKl.toLocaleString()} kL/yr diesel` : ''}${dieselKl > 0 && hfoKl > 0 ? ' + ' : ''}${hfoKl > 0 ? `${hfoKl.toLocaleString()} kL/yr HFO` : ''} from ${ex.extractedFromSection}. ${ex.notes}`,
      rawData: {
        derivation: 'direct_volume',
        dieselKl,
        hfoKl,
        midpointBbl: bblMid,
        bandPct: 0.15,
        extracted: ex,
      },
    };
  }

  // Path 2: fuel cost → volume via benchmark diesel price
  const fuelCostUsd = fc.fuelCostUsdYr;
  const fuelPctOpex = fc.fuelCostPctOfOpex;
  const totalOpex = fc.totalOpexUsdYr;
  const derivedFuelSpend =
    fuelCostUsd ??
    (fuelPctOpex != null && totalOpex != null ? (fuelPctOpex / 100) * totalOpex : null);
  if (derivedFuelSpend != null && derivedFuelSpend > 0) {
    return {
      entitySlug: match.slug,
      entityName: match.name,
      derivation: 'opex_derived',
      bblYrMin: derivedFuelSpend / DIESEL_USD_PER_BBL_MAX,
      bblYrMax: derivedFuelSpend / DIESEL_USD_PER_BBL_MIN,
      confidence: 0.65,
      signalKind: 'expenditure_signal',
      fuelType: 'diesel',
      coverageYear,
      notes: `NI 43-101: derived from $${derivedFuelSpend.toLocaleString()}/yr fuel spend ${fuelCostUsd ? '(direct line-item)' : `(${fuelPctOpex}% × $${totalOpex?.toLocaleString()} opex)`} ÷ $${DIESEL_USD_PER_BBL_MIN}-${DIESEL_USD_PER_BBL_MAX}/bbl benchmark. ${ex.notes}`,
      rawData: {
        derivation: 'opex_derived',
        fuelCostUsd,
        fuelPctOpex,
        totalOpex,
        derivedFuelSpend,
        benchmarkUsdPerBbl: { min: DIESEL_USD_PER_BBL_MIN, max: DIESEL_USD_PER_BBL_MAX },
        extracted: ex,
      },
    };
  }

  // Path 3 (production_derived): would need fuel_intensity_factors
  // join + production schedule mid-year. Skipped in v1 — when the
  // direct + opex paths both miss, the report wasn't fuel-relevant
  // enough to derive a clean signal. Logged as 'none' so the analyst
  // can re-extract with a tighter prompt if needed.
  return null;
}

async function insertSignal(d: SignalDraft, sourceUrl: string | null): Promise<void> {
  await db.execute(sql`
    DELETE FROM fuel_consumption_signals
     WHERE entity_slug = ${d.entitySlug}
       AND source = 'ni_43_101'
       AND coverage_year = ${d.coverageYear};
  `);
  await db.execute(sql`
    INSERT INTO fuel_consumption_signals (
      entity_slug, source, signal_kind, fuel_type,
      volume_bbl_yr_min, volume_bbl_yr_max,
      confidence, coverage_year, notes, source_url, raw_data
    ) VALUES (
      ${d.entitySlug},
      'ni_43_101',
      ${d.signalKind},
      ${d.fuelType},
      ${d.bblYrMin.toFixed(2)},
      ${d.bblYrMax.toFixed(2)},
      ${d.confidence},
      ${d.coverageYear},
      ${d.notes.slice(0, 1500)},
      ${sourceUrl},
      ${JSON.stringify(d.rawData)}::jsonb
    );
  `);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const path = args.find((a) => !a.startsWith('--'));
  const dryRun = args.includes('--dry-run');
  const yearArg = args.find((a) => a.startsWith('--year='));
  const yearOverride = yearArg
    ? Number.parseInt(yearArg.split('=')[1] ?? '', 10)
    : null;

  if (!path) {
    console.error(
      'Usage: pnpm --filter @procur/ai ingest-ni-43-101 <path-to-report.pdf>\n' +
        '  --year=YYYY   Coverage year (default: report effective date year, fallback current year)\n' +
        '  --dry-run     Print extraction; do not write to DB\n' +
        '\n' +
        'Download reports from https://www.sedarplus.ca/ — search by company / project.',
    );
    process.exit(1);
  }

  const resolved = resolveUserPath(path);
  console.log(`Reading ${resolved}…`);
  const { text, pageCount } = await readPdfText(resolved);
  console.log(`  ${pageCount} pages, ${text.length.toLocaleString()} chars`);

  if (text.length < 5000) {
    console.error(
      'Extracted text under 5k chars — likely a scanned PDF without OCR layer. Aborting.',
    );
    process.exit(1);
  }

  console.log('Extracting structured data via Sonnet…');
  const extracted = await extractNI43101(text);
  console.log(
    `  project=${extracted.projectName}, operator=${extracted.operatorName}, country=${extracted.projectCountryIso2}, confidence=${extracted.confidence}`,
  );
  console.log(
    `  cache: read=${extracted.usage.cacheReadTokens.toLocaleString()}, create=${extracted.usage.cacheCreationTokens.toLocaleString()}, in=${extracted.usage.inputTokens.toLocaleString()}, out=${extracted.usage.outputTokens.toLocaleString()}`,
  );

  if (extracted.confidence < 0.3) {
    console.warn(
      `  low confidence (${extracted.confidence}) — extraction notes: ${extracted.notes}`,
    );
  }

  const coverageYear =
    yearOverride ??
    (extracted.reportEffectiveDate
      ? Number.parseInt(extracted.reportEffectiveDate.slice(0, 4), 10)
      : new Date().getUTCFullYear());

  const match = await matchKnownEntity(extracted.operatorName, extracted.projectName);
  if (!match) {
    console.error(
      `  no known_entities match for project="${extracted.projectName}" or operator="${extracted.operatorName}". ` +
        'Add a known_entities row first (analyst-curated) so signals attribute correctly.',
    );
    process.exit(1);
  }
  console.log(`  matched ${match.matchedBy}: ${match.slug} (${match.name})`);

  const signal = deriveSignal(extracted, match, coverageYear);
  if (!signal) {
    console.warn(
      '  no derivation path matched (no direct volume, no opex line-item). ' +
        'Report may not be fuel-relevant. Skipping signal write.',
    );
    if (extracted.caveats.length > 0) {
      console.log('  extraction caveats:');
      for (const c of extracted.caveats) console.log(`    - ${c}`);
    }
    return;
  }

  console.log(
    `\n  derivation=${signal.derivation}, range=${(signal.bblYrMin / 1e6).toFixed(2)}-${(signal.bblYrMax / 1e6).toFixed(2)}M bbl/yr, ` +
      `confidence=${signal.confidence}, fuel=${signal.fuelType ?? 'unknown'}, year=${signal.coverageYear}`,
  );

  if (dryRun) {
    console.log('\n(dry run — no rows written.)\n');
    console.log('Extracted JSON:');
    console.log(JSON.stringify(extracted, null, 2));
    return;
  }

  await insertSignal(signal, 'https://www.sedarplus.ca/');
  console.log(`\nInserted ni_43_101 signal for ${signal.entitySlug}.`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
