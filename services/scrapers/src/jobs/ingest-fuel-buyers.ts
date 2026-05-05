/**
 * Caribbean fuel-buyer rolodex ingestion — orchestrator.
 *
 * Spec lives in `docs/caribbean-fuel-buyer-brief.md`. Single
 * dispatch point for the per-source workers across the 11
 * segments. Mirrors the env-services orchestrator pattern.
 *
 * Wired so far (Phase 1 first cut):
 *   - `utilities-seed` — Tier-1 hand-curated utilities (~22 entries)
 *
 * Stubs (return `skipped-not-implemented` until each is wired):
 *   - `mining-seed`         — Tier-1 mining buyers (Phase 1)
 *   - `marine-bunker-seed`  — Tier-1 marine bunker (Phase 1)
 *   - `aviation-seed`       — Tier-1 aviation (Phase 1)
 *   - `industrial-distributor-seed` — Tier-1 distributors (Phase 1)
 *   - `government-seed`     — Tier-1 government fleets (Phase 1)
 *   - `hospitality-seed`    — Tier-1 hospitality (Phase 1)
 *   - `agricultural-seed`   — Tier-1 agriculture (Phase 1)
 *   - `lpg-seed`            — Tier-1 LPG distributors (Phase 1)
 *   - `ocds-caribbean`      — OCDS fuel-tender ingest (Phase 2)
 *   - `customs-flows`       — Customs entity-level imports (Phase 2)
 *   - `industry-directory`  — CARILEC / IBIA / ACI cross-ref (Phase 2)
 *   - `contact-enrich`      — Apollo / Cognism Tier 1+2 (Phase 3)
 */
import { runFuelBuyerUtilitiesSeed } from './fuel-buyers/seed-utilities';

export type FuelBuyerSource =
  | 'utilities-seed'
  | 'mining-seed'
  | 'marine-bunker-seed'
  | 'aviation-seed'
  | 'industrial-distributor-seed'
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
    runFuelBuyerUtilitiesSeed().then((s) => ({
      ...s,
      source: 'utilities-seed' as const,
    })),
  'mining-seed': () => stub('mining-seed'),
  'marine-bunker-seed': () => stub('marine-bunker-seed'),
  'aviation-seed': () => stub('aviation-seed'),
  'industrial-distributor-seed': () => stub('industrial-distributor-seed'),
  'government-seed': () => stub('government-seed'),
  'hospitality-seed': () => stub('hospitality-seed'),
  'agricultural-seed': () => stub('agricultural-seed'),
  'lpg-seed': () => stub('lpg-seed'),
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
