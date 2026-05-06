/**
 * Bond prospectus + continuing disclosure ingest.
 *
 * Source per buyer-intelligence-v2-free-sources-brief.md §4.1:
 *   - Luxembourg Stock Exchange (bourse.lu/programme) — primary
 *     venue for LatAm eurobonds
 *   - MSRB EMMA (emma.msrb.org) — US municipal bonds incl. PR/USVI
 *   - SEC EDGAR — 20-F + 6-K + S-1
 *   - Bermuda + Cayman Stock Exchanges — Caribbean-domiciled
 *   - CVM Brazil (cvm.gov.br), CNV Argentina, CMF Chile, etc.
 *
 * Caribbean coverage strong for: Cementos Argos, Cemex Latam, Holcim
 * Caribbean affiliates, AES Dominicana, EGE Haina, JBC Bauxite
 * (when issuing). Moderate for DR utilities + Puerto Rico utilities
 * (PREPA continuing disclosure). Weak for privately-held mid-market.
 *
 * File-path-driven first cut (same shape as ingest-eu-mrv +
 * ingest-ni-43-101). Scraper for batch download is a follow-up.
 *
 * Pipeline:
 *   1. unpdf → plain text
 *   2. tasks/extract-bond-prospectus → structured Sonnet extraction
 *      (multi-segment + hedging + risk factor)
 *   3. pg_trgm match against known_entities by issuer name. NEVER
 *      auto-creates entities. Logs + skips on no match.
 *   4. For each segment with fuel data, choose derivation path:
 *        a) Direct annual_diesel_kl + hfo_kl → 0.85 confidence
 *        b) annual_fuel_cost_usd ÷ benchmark price → 0.65 confidence,
 *           signal_kind='expenditure_signal'
 *        c) fuel_cost_pct × total_segment_opex ÷ benchmark → 0.55,
 *           signal_kind='expenditure_signal'
 *   5. Sum across segments → one signal row per (issuer, year)
 *      OR skip aggregation when --per-segment passed (drops one row
 *      per segment at the issuer's slug — last write wins, so prefer
 *      summing).
 *   6. Insert at source='bond_prospectus'. Idempotent on
 *      (entity_slug, source, coverage_year).
 *
 * Run from repo root:
 *   pnpm --filter @procur/ai ingest-bond-prospectus <path-to-prospectus.pdf>
 *   pnpm --filter @procur/ai ingest-bond-prospectus <path> --year=2024
 *   pnpm --filter @procur/ai ingest-bond-prospectus <path> --dry-run
 */
import 'dotenv/config';
import { config as loadEnv } from 'dotenv';
import { readFile } from 'node:fs/promises';
import { resolve, isAbsolute } from 'node:path';
import { sql } from 'drizzle-orm';
import { extractText as unpdfExtract, getDocumentProxy } from 'unpdf';
import { db } from '@procur/db/client';
import {
  extractBondProspectus,
  type BondProspectusOutputT,
} from './tasks/extract-bond-prospectus';

loadEnv({ path: '../../.env.local' });
loadEnv({ path: '../../.env' });

const L_PER_BBL = 158.987;

// Benchmark fuel prices for the expenditure→volume fallback. Wider
// band than NI 43-101 because bond-prospectus issuers span sectors
// (utilities, cement, mining, refining) with different landed-fuel
// prices. The output range bracket reflects this — analyst can read
// the rawData provenance to assess.
const FUEL_USD_PER_BBL_MIN = 100; // bulk industrial / cement
const FUEL_USD_PER_BBL_MAX = 200; // remote mining / Caribbean utility

type DerivationPath =
  | 'direct_volume'
  | 'opex_pct_derived'
  | 'opex_total_derived'
  | 'none';

type SegmentSignal = {
  derivation: DerivationPath;
  bblYrMin: number;
  bblYrMax: number;
  confidence: number;
  signalKind: 'volume_estimate' | 'expenditure_signal';
  fuelType: 'diesel' | 'hfo' | 'mixed' | null;
  segmentName: string;
  derivationDetail: Record<string, unknown>;
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

async function matchKnownEntity(
  issuerName: string,
): Promise<{ slug: string; name: string } | null> {
  // Bond prospectuses identify the issuer (legal entity) not project
  // — match by company name only. Lower threshold than NI 43-101's
  // project-name match (issuer names are usually uniquely identifying).
  const rows = (await db.execute(sql`
    SELECT slug, name, similarity(name, ${issuerName}) AS score
      FROM known_entities
     WHERE similarity(name, ${issuerName}) > 0.50
     ORDER BY score DESC
     LIMIT 1;
  `)) as unknown as Array<{ slug: string; name: string; score: number }>;
  if (rows.length === 0 || !rows[0]) return null;
  return { slug: rows[0].slug, name: rows[0].name };
}

function pickFuelType(
  segment: BondProspectusOutputT['segments'][number],
): 'diesel' | 'hfo' | 'mixed' | null {
  const hasDiesel = segment.annualDieselKilolitres != null && segment.annualDieselKilolitres > 0;
  const hasHfo = segment.annualHfoKilolitres != null && segment.annualHfoKilolitres > 0;
  if (hasDiesel && hasHfo) return 'mixed';
  if (hasHfo) return 'hfo';
  if (hasDiesel) return 'diesel';
  return null;
}

function bblFromKl(kl: number): number {
  return (kl * 1000) / L_PER_BBL;
}

function deriveSegmentSignal(
  segment: BondProspectusOutputT['segments'][number],
): SegmentSignal | null {
  const dieselKl = segment.annualDieselKilolitres ?? 0;
  const hfoKl = segment.annualHfoKilolitres ?? 0;

  // Path 1: direct fuel volumes
  if (dieselKl > 0 || hfoKl > 0) {
    const bblMid = bblFromKl(dieselKl + hfoKl);
    return {
      derivation: 'direct_volume',
      bblYrMin: bblMid * 0.85,
      bblYrMax: bblMid * 1.15,
      confidence: 0.85,
      signalKind: 'volume_estimate',
      fuelType: pickFuelType(segment),
      segmentName: segment.name,
      derivationDetail: {
        path: 'direct_volume',
        dieselKl,
        hfoKl,
        midpointBbl: bblMid,
      },
    };
  }

  // Path 2: direct fuel cost
  const fuelCost = segment.annualFuelCostUsd;
  if (fuelCost != null && fuelCost > 0) {
    return {
      derivation: 'opex_total_derived',
      bblYrMin: fuelCost / FUEL_USD_PER_BBL_MAX,
      bblYrMax: fuelCost / FUEL_USD_PER_BBL_MIN,
      confidence: 0.65,
      signalKind: 'expenditure_signal',
      fuelType: 'mixed',
      segmentName: segment.name,
      derivationDetail: {
        path: 'opex_total_derived',
        fuelCostUsd: fuelCost,
        benchmarkUsdPerBbl: { min: FUEL_USD_PER_BBL_MIN, max: FUEL_USD_PER_BBL_MAX },
      },
    };
  }

  // Path 3: fuel % of opex × total opex
  const pct = segment.fuelCostPctOfOpex;
  const opex = segment.totalSegmentOpexUsd;
  if (pct != null && pct > 0 && opex != null && opex > 0) {
    const fuelSpend = (pct / 100) * opex;
    return {
      derivation: 'opex_pct_derived',
      bblYrMin: fuelSpend / FUEL_USD_PER_BBL_MAX,
      bblYrMax: fuelSpend / FUEL_USD_PER_BBL_MIN,
      confidence: 0.55,
      signalKind: 'expenditure_signal',
      fuelType: 'mixed',
      segmentName: segment.name,
      derivationDetail: {
        path: 'opex_pct_derived',
        fuelPctOpex: pct,
        totalSegmentOpexUsd: opex,
        derivedFuelSpendUsd: fuelSpend,
        benchmarkUsdPerBbl: { min: FUEL_USD_PER_BBL_MIN, max: FUEL_USD_PER_BBL_MAX },
      },
    };
  }

  return null;
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
      'Usage: pnpm --filter @procur/ai ingest-bond-prospectus <path-to-prospectus.pdf>\n' +
        '  --year=YYYY   Coverage year (default: filing year)\n' +
        '  --dry-run     Print extraction; do not write to DB\n' +
        '\n' +
        'Sources: bourse.lu, emma.msrb.org, www.sec.gov/edgar, BSX, ' +
        'CVM Brazil, CNV Argentina, CMF Chile.',
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
  const extracted = await extractBondProspectus(text);
  console.log(
    `  issuer=${extracted.issuerName}, country=${extracted.issuerCountryIso2}, ` +
      `type=${extracted.prospectusType}, exchange=${extracted.filingExchange}, ` +
      `segments=${extracted.segments.length}, hedging=${extracted.fuelHedging?.hasHedgingProgram ?? 'n/a'}, ` +
      `confidence=${extracted.confidence}`,
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
    (extracted.filingDate
      ? Number.parseInt(extracted.filingDate.slice(0, 4), 10)
      : new Date().getUTCFullYear());

  const match = await matchKnownEntity(extracted.issuerName);
  if (!match) {
    console.error(
      `  no known_entities match for issuer="${extracted.issuerName}". ` +
        'Add a known_entities row first (analyst-curated) so signals attribute correctly.',
    );
    process.exit(1);
  }
  console.log(`  matched: ${match.slug} (${match.name})`);

  // Derive per-segment, then sum at the issuer level.
  const segmentSignals = extracted.segments
    .map(deriveSegmentSignal)
    .filter((s): s is SegmentSignal => s != null);

  if (segmentSignals.length === 0) {
    console.warn(
      '  no derivable segments. Document may be qualitative-only or non-fuel-relevant.',
    );
    if (extracted.fuelHedging?.hasHedgingProgram) {
      console.log(
        `  hedging program disclosed: ${extracted.fuelHedging.hedgeNotes ?? '(qualitative only)'}`,
      );
    }
    if (extracted.caveats.length > 0) {
      console.log('  caveats:');
      for (const c of extracted.caveats) console.log(`    - ${c}`);
    }
    return;
  }

  // Sum bbl ranges across segments. Confidence is the volume-weighted
  // average of the segment confidences — a single direct-volume
  // segment + several opex-derived segments shouldn't drag the
  // overall confidence down to opex-derived level.
  const bblYrMin = segmentSignals.reduce((s, x) => s + x.bblYrMin, 0);
  const bblYrMax = segmentSignals.reduce((s, x) => s + x.bblYrMax, 0);
  const bblYrMid = (bblYrMin + bblYrMax) / 2;
  const weightedConfidence =
    segmentSignals.reduce((acc, s) => acc + s.confidence * (s.bblYrMin + s.bblYrMax), 0) /
    segmentSignals.reduce((acc, s) => acc + (s.bblYrMin + s.bblYrMax), 0);

  // Pick the dominant signal_kind — if any segment is direct-volume,
  // call the aggregate volume_estimate; otherwise expenditure_signal.
  const signalKind: 'volume_estimate' | 'expenditure_signal' = segmentSignals.some(
    (s) => s.signalKind === 'volume_estimate',
  )
    ? 'volume_estimate'
    : 'expenditure_signal';

  const fuelTypes = new Set(segmentSignals.map((s) => s.fuelType).filter(Boolean));
  const fuelType =
    fuelTypes.size === 1
      ? (segmentSignals.find((s) => s.fuelType)?.fuelType ?? null)
      : fuelTypes.size > 1
        ? 'mixed'
        : null;

  const notes =
    `Bond prospectus (${extracted.prospectusType}) filed on ${extracted.filingExchange}. ` +
    `${segmentSignals.length} segment${segmentSignals.length === 1 ? '' : 's'} derivable, ` +
    `mid-range ${(bblYrMid / 1e6).toFixed(2)}M bbl/yr. ` +
    `${extracted.fuelHedging?.hasHedgingProgram ? 'Active fuel hedging disclosed. ' : ''}` +
    extracted.notes;

  const rawData = {
    extraction: extracted,
    derivedSegments: segmentSignals.map((s) => ({
      segment: s.segmentName,
      derivation: s.derivation,
      bblYrMin: s.bblYrMin,
      bblYrMax: s.bblYrMax,
      confidence: s.confidence,
      detail: s.derivationDetail,
    })),
    aggregation: {
      bblYrMin,
      bblYrMax,
      weightedConfidence,
      signalKind,
      fuelType,
    },
  };

  console.log(
    `\n  aggregate: range=${(bblYrMin / 1e6).toFixed(2)}-${(bblYrMax / 1e6).toFixed(2)}M bbl/yr, ` +
      `confidence=${weightedConfidence.toFixed(2)}, kind=${signalKind}, fuel=${fuelType ?? 'unknown'}, year=${coverageYear}`,
  );
  for (const s of segmentSignals) {
    console.log(
      `    ${s.segmentName}: ${(s.bblYrMin / 1e6).toFixed(2)}-${(s.bblYrMax / 1e6).toFixed(2)}M (${s.derivation}, conf=${s.confidence})`,
    );
  }

  if (dryRun) {
    console.log('\n(dry run — no rows written.)\n');
    console.log('Extracted JSON:');
    console.log(JSON.stringify(extracted, null, 2));
    return;
  }

  await db.execute(sql`
    DELETE FROM fuel_consumption_signals
     WHERE entity_slug = ${match.slug}
       AND source = 'bond_prospectus'
       AND coverage_year = ${coverageYear};
  `);
  await db.execute(sql`
    INSERT INTO fuel_consumption_signals (
      entity_slug, source, signal_kind, fuel_type,
      volume_bbl_yr_min, volume_bbl_yr_max,
      confidence, coverage_year, notes, source_url, raw_data
    ) VALUES (
      ${match.slug},
      'bond_prospectus',
      ${signalKind},
      ${fuelType},
      ${bblYrMin.toFixed(2)},
      ${bblYrMax.toFixed(2)},
      ${weightedConfidence.toFixed(2)},
      ${coverageYear},
      ${notes.slice(0, 1500)},
      ${extracted.filingExchange.toLowerCase().includes('luxembourg') ? 'https://www.bourse.lu/' : extracted.filingExchange.toLowerCase().includes('emma') ? 'https://emma.msrb.org/' : extracted.filingExchange.toLowerCase().includes('edgar') ? 'https://www.sec.gov/edgar/' : null},
      ${JSON.stringify(rawData)}::jsonb
    );
  `);

  console.log(`\nInserted bond_prospectus signal for ${match.slug}.`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
