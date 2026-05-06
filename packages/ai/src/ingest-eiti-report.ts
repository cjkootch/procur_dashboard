/**
 * EITI country report ingest.
 *
 * Per buyer-intelligence-v2-free-sources-brief.md §4.5. EITI is a
 * global transparency standard requiring participating countries to
 * publish detailed annual reports on extractive-sector activity:
 * company-level production, government revenues, and operational
 * disclosures. For energy-relevant Caribbean basin countries, these
 * reports include data procur can convert to fuel-consumption
 * signals.
 *
 * Sources:
 *   - tteiti.org.tt — Trinidad and Tobago, strong oil + gas detail
 *   - eiti.gov.sr — Suriname, gold + emerging oil
 *   - guyanaeiti.org — Guyana, oil-sector focus (Stabroek)
 *   - eiti.do — Dominican Republic, mining sector
 *   - International EITI: eiti.org/countries
 *
 * One report covers MANY companies. The extraction returns an array;
 * the ingest script matches each company against known_entities by
 * name (pg_trgm) and emits one signal per matched company.
 *
 * Pipeline:
 *   1. unpdf → plain text
 *   2. tasks/extract-eiti-report → multi-company structured extraction
 *   3. For each extracted company:
 *      a) pg_trgm match against known_entities by name. NEVER auto-
 *         creates entities. Skip on no match.
 *      b) Choose derivation path:
 *           direct_volume — diesel_kL + hfo_kL → 0.80 confidence
 *           opex_total_derived — fuel_cost_usd ÷ benchmark → 0.65
 *           opex_pct_derived — pct × opex ÷ benchmark → 0.55
 *           govt_payment_proxy — government_payments_usd as opex
 *             proxy ÷ benchmark → 0.45 confidence,
 *             signal_kind='activity_signal' (proxy, not real cost)
 *      c) Insert at source='eiti'. Idempotent on
 *         (entity_slug, source, coverage_year).
 *
 * Run from repo root:
 *   pnpm --filter @procur/ai ingest-eiti-report <path-to-eiti-report.pdf>
 *   pnpm --filter @procur/ai ingest-eiti-report <path> --dry-run
 *   pnpm --filter @procur/ai ingest-eiti-report <path> --year=2023
 */
import 'dotenv/config';
import { config as loadEnv } from 'dotenv';
import { readFile } from 'node:fs/promises';
import { resolve, isAbsolute } from 'node:path';
import { sql } from 'drizzle-orm';
import { extractText as unpdfExtract, getDocumentProxy } from 'unpdf';
import { db } from '@procur/db/client';
import {
  extractEITIReport,
  type EITIReportOutputT,
} from './tasks/extract-eiti-report';

loadEnv({ path: '../../.env.local' });
loadEnv({ path: '../../.env' });

const L_PER_BBL = 158.987;
const FUEL_USD_PER_BBL_MIN = 100;
const FUEL_USD_PER_BBL_MAX = 200;

// Government payments are a wider proxy than direct opex — they
// include royalties + corporate income tax + fees, which scale with
// production but are a noisier estimator of fuel spend specifically.
// Convert to fuel-spend by assuming fuel ≈ 8-15% of govt-payment-
// equivalent total opex (industry rough heuristic).
const GOVT_PAYMENT_TO_FUEL_RATIO_MIN = 0.05;
const GOVT_PAYMENT_TO_FUEL_RATIO_MAX = 0.15;

type DerivationPath =
  | 'direct_volume'
  | 'opex_total_derived'
  | 'opex_pct_derived'
  | 'govt_payment_proxy'
  | 'none';

type CompanySignal = {
  entitySlug: string;
  entityName: string;
  derivation: DerivationPath;
  bblYrMin: number;
  bblYrMax: number;
  confidence: number;
  signalKind: 'volume_estimate' | 'expenditure_signal' | 'activity_signal';
  fuelType: 'diesel' | 'hfo' | 'mixed' | null;
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

async function matchKnownEntity(
  companyName: string,
): Promise<{ slug: string; name: string } | null> {
  const rows = (await db.execute(sql`
    SELECT slug, name, similarity(name, ${companyName}) AS score
      FROM known_entities
     WHERE similarity(name, ${companyName}) > 0.50
     ORDER BY score DESC
     LIMIT 1;
  `)).rows as unknown as Array<{ slug: string; name: string; score: number }>;
  if (rows.length === 0 || !rows[0]) return null;
  return { slug: rows[0].slug, name: rows[0].name };
}

function bblFromKl(kl: number): number {
  return (kl * 1000) / L_PER_BBL;
}

function pickFuelType(
  c: EITIReportOutputT['companies'][number],
): 'diesel' | 'hfo' | 'mixed' | null {
  const hasDiesel = c.annualDieselKilolitres != null && c.annualDieselKilolitres > 0;
  const hasHfo = c.annualHfoKilolitres != null && c.annualHfoKilolitres > 0;
  if (hasDiesel && hasHfo) return 'mixed';
  if (hasHfo) return 'hfo';
  if (hasDiesel) return 'diesel';
  return null;
}

function deriveCompanySignal(
  c: EITIReportOutputT['companies'][number],
  match: { slug: string; name: string },
): CompanySignal | null {
  // Path 1: direct fuel volumes
  const dieselKl = c.annualDieselKilolitres ?? 0;
  const hfoKl = c.annualHfoKilolitres ?? 0;
  if (dieselKl > 0 || hfoKl > 0) {
    const bblMid = bblFromKl(dieselKl + hfoKl);
    return {
      entitySlug: match.slug,
      entityName: match.name,
      derivation: 'direct_volume',
      bblYrMin: bblMid * 0.85,
      bblYrMax: bblMid * 1.15,
      confidence: 0.8,
      signalKind: 'volume_estimate',
      fuelType: pickFuelType(c),
      notes: `EITI direct disclosure ${dieselKl > 0 ? `${dieselKl.toLocaleString()} kL/yr diesel` : ''}${dieselKl > 0 && hfoKl > 0 ? ' + ' : ''}${hfoKl > 0 ? `${hfoKl.toLocaleString()} kL/yr HFO` : ''}.`,
      rawData: {
        derivation: 'direct_volume',
        dieselKl,
        hfoKl,
        midpointBbl: bblMid,
        sector: c.sector,
      },
    };
  }

  // Path 2: direct fuel cost
  if (c.annualFuelCostUsd != null && c.annualFuelCostUsd > 0) {
    return {
      entitySlug: match.slug,
      entityName: match.name,
      derivation: 'opex_total_derived',
      bblYrMin: c.annualFuelCostUsd / FUEL_USD_PER_BBL_MAX,
      bblYrMax: c.annualFuelCostUsd / FUEL_USD_PER_BBL_MIN,
      confidence: 0.65,
      signalKind: 'expenditure_signal',
      fuelType: 'mixed',
      notes: `EITI: $${c.annualFuelCostUsd.toLocaleString()}/yr fuel spend ÷ $${FUEL_USD_PER_BBL_MIN}-${FUEL_USD_PER_BBL_MAX}/bbl benchmark.`,
      rawData: {
        derivation: 'opex_total_derived',
        fuelCostUsd: c.annualFuelCostUsd,
        benchmarkUsdPerBbl: { min: FUEL_USD_PER_BBL_MIN, max: FUEL_USD_PER_BBL_MAX },
        sector: c.sector,
      },
    };
  }

  // Path 3: fuel % of opex × total opex
  if (
    c.fuelCostPctOfOpex != null &&
    c.fuelCostPctOfOpex > 0 &&
    c.totalCompanyOpexUsd != null &&
    c.totalCompanyOpexUsd > 0
  ) {
    const fuelSpend = (c.fuelCostPctOfOpex / 100) * c.totalCompanyOpexUsd;
    return {
      entitySlug: match.slug,
      entityName: match.name,
      derivation: 'opex_pct_derived',
      bblYrMin: fuelSpend / FUEL_USD_PER_BBL_MAX,
      bblYrMax: fuelSpend / FUEL_USD_PER_BBL_MIN,
      confidence: 0.55,
      signalKind: 'expenditure_signal',
      fuelType: 'mixed',
      notes: `EITI: ${c.fuelCostPctOfOpex}% × $${c.totalCompanyOpexUsd.toLocaleString()} opex = $${fuelSpend.toLocaleString()}/yr fuel ÷ benchmark.`,
      rawData: {
        derivation: 'opex_pct_derived',
        fuelPctOpex: c.fuelCostPctOfOpex,
        totalOpex: c.totalCompanyOpexUsd,
        derivedFuelSpendUsd: fuelSpend,
        benchmarkUsdPerBbl: { min: FUEL_USD_PER_BBL_MIN, max: FUEL_USD_PER_BBL_MAX },
        sector: c.sector,
      },
    };
  }

  // Path 4: government payment proxy. Wider band, lower confidence.
  // Only useful as a coarse "this counterparty has fuel exposure"
  // signal — flagged as activity_signal, not volume_estimate.
  if (c.governmentPaymentsUsd != null && c.governmentPaymentsUsd > 0) {
    const fuelSpendMin = c.governmentPaymentsUsd * GOVT_PAYMENT_TO_FUEL_RATIO_MIN;
    const fuelSpendMax = c.governmentPaymentsUsd * GOVT_PAYMENT_TO_FUEL_RATIO_MAX;
    return {
      entitySlug: match.slug,
      entityName: match.name,
      derivation: 'govt_payment_proxy',
      bblYrMin: fuelSpendMin / FUEL_USD_PER_BBL_MAX,
      bblYrMax: fuelSpendMax / FUEL_USD_PER_BBL_MIN,
      confidence: 0.45,
      signalKind: 'activity_signal',
      fuelType: null,
      notes: `EITI proxy: $${c.governmentPaymentsUsd.toLocaleString()}/yr govt payments × ${(GOVT_PAYMENT_TO_FUEL_RATIO_MIN * 100).toFixed(0)}-${(GOVT_PAYMENT_TO_FUEL_RATIO_MAX * 100).toFixed(0)}% fuel-cost share heuristic ÷ benchmark.`,
      rawData: {
        derivation: 'govt_payment_proxy',
        governmentPaymentsUsd: c.governmentPaymentsUsd,
        fuelShareRange: {
          min: GOVT_PAYMENT_TO_FUEL_RATIO_MIN,
          max: GOVT_PAYMENT_TO_FUEL_RATIO_MAX,
        },
        benchmarkUsdPerBbl: { min: FUEL_USD_PER_BBL_MIN, max: FUEL_USD_PER_BBL_MAX },
        sector: c.sector,
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
      'Usage: pnpm --filter @procur/ai ingest-eiti-report <path-to-eiti-report.pdf>\n' +
        '  --year=YYYY   Coverage year (default: report\'s reportingYear)\n' +
        '  --dry-run     Print extraction; do not write to DB\n' +
        '\n' +
        'Sources: tteiti.org.tt, eiti.gov.sr, guyanaeiti.org, eiti.do, eiti.org/countries.',
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
  const extracted = await extractEITIReport(text);
  console.log(
    `  country=${extracted.reportingCountryIso2}, year=${extracted.reportingYear}, ` +
      `companies=${extracted.companies.length}, confidence=${extracted.confidence}`,
  );
  console.log(
    `  cache: read=${extracted.usage.cacheReadTokens.toLocaleString()}, create=${extracted.usage.cacheCreationTokens.toLocaleString()}, in=${extracted.usage.inputTokens.toLocaleString()}, out=${extracted.usage.outputTokens.toLocaleString()}`,
  );

  if (extracted.confidence < 0.3) {
    console.warn(
      `  low confidence (${extracted.confidence}) — extraction notes: ${extracted.notes}`,
    );
  }

  const coverageYear = yearOverride ?? extracted.reportingYear ?? new Date().getUTCFullYear();

  const matched: CompanySignal[] = [];
  const unmatched: string[] = [];
  const noDerivation: string[] = [];

  for (const c of extracted.companies) {
    const match = await matchKnownEntity(c.name);
    if (!match) {
      unmatched.push(c.name);
      continue;
    }
    const signal = deriveCompanySignal(c, match);
    if (!signal) {
      noDerivation.push(`${c.name} → ${match.slug}`);
      continue;
    }
    matched.push(signal);
  }

  console.log(`\n  ${matched.length} signals derivable, ${unmatched.length} unmatched, ${noDerivation.length} matched-but-no-fuel-data`);
  if (matched.length > 0) {
    console.log('  signals:');
    for (const s of matched) {
      console.log(
        `    ${s.entityName}: ${(s.bblYrMin / 1e6).toFixed(2)}-${(s.bblYrMax / 1e6).toFixed(2)}M bbl/yr (${s.derivation}, conf=${s.confidence})`,
      );
    }
  }
  if (unmatched.length > 0 && unmatched.length <= 30) {
    console.log('  unmatched company names:');
    for (const n of unmatched) console.log(`    ${n}`);
  }
  if (noDerivation.length > 0 && noDerivation.length <= 20) {
    console.log('  matched but no fuel/cost/payment data:');
    for (const n of noDerivation) console.log(`    ${n}`);
  }

  if (dryRun) {
    console.log('\n(dry run — no rows written.)');
    return;
  }

  let inserted = 0;
  for (const s of matched) {
    await db.execute(sql`
      DELETE FROM fuel_consumption_signals
       WHERE entity_slug = ${s.entitySlug}
         AND source = 'eiti'
         AND coverage_year = ${coverageYear};
    `);
    await db.execute(sql`
      INSERT INTO fuel_consumption_signals (
        entity_slug, source, signal_kind, fuel_type,
        volume_bbl_yr_min, volume_bbl_yr_max,
        confidence, coverage_year, notes, source_url, raw_data
      ) VALUES (
        ${s.entitySlug},
        'eiti',
        ${s.signalKind},
        ${s.fuelType},
        ${s.bblYrMin.toFixed(2)},
        ${s.bblYrMax.toFixed(2)},
        ${s.confidence},
        ${coverageYear},
        ${s.notes.slice(0, 1500)},
        ${`https://eiti.org/countries/${(extracted.reportingCountryIso2 ?? '').toLowerCase()}`},
        ${JSON.stringify(s.rawData)}::jsonb
      );
    `);
    inserted += 1;
  }

  console.log(`\nInserted ${inserted} eiti signal rows for coverage year ${coverageYear}.`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
