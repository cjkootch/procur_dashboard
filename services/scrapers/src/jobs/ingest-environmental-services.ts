/**
 * Environmental services rolodex ingestion — orchestrator.
 *
 * Spec lives in `docs/environmental-services-rolodex-brief.md`. This
 * file is the entry point for the Phase 1 + Phase 2 + Phase 3
 * ingestion workstreams; each source has its own dedicated worker
 * file (one per regulator), invoked from here.
 *
 * Wired so far (Phase 1 first cut):
 *   - `epa-rcra`        — EPA Envirofacts REST API, NAICS-filtered
 *   - `anla`            — ANLA Colombia open-data portal (CKAN)
 *   - `curated-seed`    — manually-curated LatAm + USGC seed
 *
 * Stubs (return `skipped-not-implemented` until each is wired):
 *   - `ibama-ctf`       — IBAMA CTF/APP per-CNPJ verification (BR)
 *   - `energy-dais`     — commercial directory cross-reference
 *   - `semarnat`        — Mexico 15 rubros PDFs (OCR pipeline)
 *   - `co-cars`         — Colombian regional CARs (5 priority)
 *   - `ar-provinces`    — Argentine provincial Sec. de Ambiente
 *   - `latam-other`     — Peru / Ecuador / Trinidad / Guyana
 *   - `contact-enrich`  — Apollo / Cognism Tier 1+2 enrichment
 *
 * The dispatcher returns a structured run summary so the cron logger
 * can record per-source counts without touching the workers.
 */
import { runAnla } from './environmental-services/anla-colombia';
import { runEpaRcra } from './environmental-services/epa-rcra';
import { runSemarnat } from './environmental-services/semarnat-mexico';
import { runCuratedSeed } from './environmental-services/seed-curated';

export type EnvServicesSource =
  | 'epa-rcra'
  | 'ibama-ctf'
  | 'anla'
  | 'energy-dais'
  | 'curated-seed'
  | 'semarnat'
  | 'co-cars'
  | 'ar-provinces'
  | 'latam-other'
  | 'contact-enrich';

export type RunSummary = {
  source: EnvServicesSource;
  /** Status reported by the per-source worker. */
  /** ok = ran successfully (may have non-fatal errors).
   *  skipped-not-implemented = stub worker, source not yet wired.
   *  skipped-needs-discovery = wired but missing config (e.g. dataset id).
   *  error = ran but no rows landed and at least one fatal error. */
  status: 'ok' | 'skipped-not-implemented' | 'skipped-needs-discovery' | 'error';
  upserted: number;
  skipped: number;
  errors: string[];
  startedAt: string;
  finishedAt: string;
};

/**
 * Per-source worker registry. Each entry returns a Promise<RunSummary>
 * when invoked. Workers that aren't wired yet return
 * `status: 'skipped-not-implemented'` so the orchestrator can fail
 * forward — partial Phase 1 ingestion is the expected mode during
 * rollout.
 */
const WORKERS: Record<EnvServicesSource, () => Promise<RunSummary>> = {
  'epa-rcra': () =>
    runEpaRcra().then(
      (s) => ({ ...s, source: 'epa-rcra' as const }),
    ),
  'ibama-ctf': () => stub('ibama-ctf'),
  anla: () =>
    runAnla().then((s) => ({ ...s, source: 'anla' as const })),
  'energy-dais': () => stub('energy-dais'),
  'curated-seed': () =>
    runCuratedSeed().then((s) => ({ ...s, source: 'curated-seed' as const })),
  semarnat: () =>
    runSemarnat().then((s) => ({ ...s, source: 'semarnat' as const })),
  'co-cars': () => stub('co-cars'),
  'ar-provinces': () => stub('ar-provinces'),
  'latam-other': () => stub('latam-other'),
  'contact-enrich': () => stub('contact-enrich'),
};

/** Run a single source by slug. */
export async function run(source: EnvServicesSource): Promise<RunSummary> {
  return WORKERS[source]();
}

/** Run every source in order. Continues past worker errors —
 *  partial Phase 1 ingestion is the expected mode (one source's
 *  4xx shouldn't block another source's clean run). The CLI exits
 *  non-zero only when EVERY worker errored, not just one. */
export async function runAll(): Promise<RunSummary[]> {
  const summaries: RunSummary[] = [];
  for (const source of Object.keys(WORKERS) as EnvServicesSource[]) {
    try {
      const summary = await WORKERS[source]();
      summaries.push(summary);
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

async function stub(source: EnvServicesSource): Promise<RunSummary> {
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
