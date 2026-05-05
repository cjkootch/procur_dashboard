/**
 * Caribbean fuel-buyer rolodex ingestion — orchestrator.
 *
 * Spec lives in `docs/caribbean-fuel-buyer-brief.md`. Single
 * dispatch point for the per-source workers across the 11
 * segments. Mirrors the env-services orchestrator pattern.
 *
 * Wired Tier-1 segment seeds (Phase 1):
 *   - `utilities-seed`              — power utilities (~22 entries)
 *   - `mining-seed`                 — bauxite/alumina/nickel/gold
 *   - `marine-bunker-seed`          — bunker suppliers + cruise corp
 *   - `aviation-seed`               — handlers + airlines
 *   - `industrial-distributor-seed` — multinationals + independents
 *   - `construction-seed`           — Caribbean infra contractors
 *   - `government-seed`             — military + public transport
 *   - `hospitality-seed`            — major resort operators
 *   - `lpg-seed`                    — LPG distributors
 *
 * Stubs (return `skipped-not-implemented` until each is wired):
 *   - `agricultural-seed`   — fragmented; needs focused curation (§4.9)
 *   - `ocds-caribbean`      — OCDS fuel-tender ingest (Phase 2)
 *   - `customs-flows`       — Customs entity-level imports (Phase 2)
 *   - `industry-directory`  — CARILEC / IBIA / ACI cross-ref (Phase 2)
 *   - `contact-enrich`      — Apollo / Cognism Tier 1+2 (Phase 3)
 */
import { runFuelBuyerAviationSeed } from './fuel-buyers/seed-aviation';
import { runFuelBuyerConstructionSeed } from './fuel-buyers/seed-construction';
import { runFuelBuyerGovernmentSeed } from './fuel-buyers/seed-government';
import { runFuelBuyerHospitalitySeed } from './fuel-buyers/seed-hospitality';
import { runFuelBuyerIndustrialDistributorSeed } from './fuel-buyers/seed-industrial-distributors';
import { runFuelBuyerLpgSeed } from './fuel-buyers/seed-lpg';
import { runFuelBuyerMarineBunkerSeed } from './fuel-buyers/seed-marine-bunker';
import { runFuelBuyerMiningSeed } from './fuel-buyers/seed-mining';
import { runFuelBuyerUtilitiesSeed } from './fuel-buyers/seed-utilities';

export type FuelBuyerSource =
  | 'utilities-seed'
  | 'mining-seed'
  | 'marine-bunker-seed'
  | 'aviation-seed'
  | 'industrial-distributor-seed'
  | 'construction-seed'
  | 'government-seed'
  | 'hospitality-seed'
  | 'agricultural-seed'
  | 'lpg-seed'
  | 'ocds-caribbean'
  | 'customs-flows'
  | 'industry-directory'
  | 'contact-enrich';

export type FuelBuyerRunSummary = {
  source: FuelBuyerSource;
  status: 'ok' | 'skipped-not-implemented' | 'skipped-needs-discovery' | 'error';
  upserted: number;
  skipped: number;
  errors: string[];
  startedAt: string;
  finishedAt: string;
};

const WORKERS: Record<FuelBuyerSource, () => Promise<FuelBuyerRunSummary>> = {
  'utilities-seed': () =>
    runFuelBuyerUtilitiesSeed().then((s) => ({ ...s, source: 'utilities-seed' as const })),
  'mining-seed': () =>
    runFuelBuyerMiningSeed().then((s) => ({ ...s, source: 'mining-seed' as const })),
  'marine-bunker-seed': () =>
    runFuelBuyerMarineBunkerSeed().then((s) => ({
      ...s,
      source: 'marine-bunker-seed' as const,
    })),
  'aviation-seed': () =>
    runFuelBuyerAviationSeed().then((s) => ({ ...s, source: 'aviation-seed' as const })),
  'industrial-distributor-seed': () =>
    runFuelBuyerIndustrialDistributorSeed().then((s) => ({
      ...s,
      source: 'industrial-distributor-seed' as const,
    })),
  'government-seed': () =>
    runFuelBuyerGovernmentSeed().then((s) => ({
      ...s,
      source: 'government-seed' as const,
    })),
  'hospitality-seed': () =>
    runFuelBuyerHospitalitySeed().then((s) => ({
      ...s,
      source: 'hospitality-seed' as const,
    })),
  // agricultural segment is fragmented + low public disclosure — staying
  // stubbed pending a focused curation pass per brief §4.9.
  'agricultural-seed': () => stub('agricultural-seed'),
  'lpg-seed': () =>
    runFuelBuyerLpgSeed().then((s) => ({ ...s, source: 'lpg-seed' as const })),
  'construction-seed': () =>
    runFuelBuyerConstructionSeed().then((s) => ({
      ...s,
      source: 'construction-seed' as const,
    })),
  'ocds-caribbean': () => stub('ocds-caribbean'),
  'customs-flows': () => stub('customs-flows'),
  'industry-directory': () => stub('industry-directory'),
  'contact-enrich': () => stub('contact-enrich'),
};

export async function run(source: FuelBuyerSource): Promise<FuelBuyerRunSummary> {
  return WORKERS[source]();
}

export async function runAll(): Promise<FuelBuyerRunSummary[]> {
  const summaries: FuelBuyerRunSummary[] = [];
  for (const source of Object.keys(WORKERS) as FuelBuyerSource[]) {
    try {
      summaries.push(await WORKERS[source]());
    } catch (err) {
      const ts = new Date().toISOString();
      summaries.push({
        source,
        status: 'error',
        upserted: 0,
        skipped: 0,
        errors: [(err as Error).message],
        startedAt: ts,
        finishedAt: ts,
      });
    }
  }
  return summaries;
}

async function stub(source: FuelBuyerSource): Promise<FuelBuyerRunSummary> {
  const ts = new Date().toISOString();
  return {
    source,
    status: 'skipped-not-implemented',
    upserted: 0,
    skipped: 0,
    errors: [],
    startedAt: ts,
    finishedAt: ts,
  };
}
