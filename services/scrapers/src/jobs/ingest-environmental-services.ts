/**
 * Environmental services rolodex ingestion — orchestrator stub.
 *
 * Spec lives in `docs/environmental-services-rolodex-brief.md`. This
 * file is the entry point for the Phase 1 + Phase 2 + Phase 3
 * ingestion workstreams; each source has its own dedicated worker
 * file (one per regulator), invoked from here.
 *
 * Current state: SCAFFOLD ONLY. The Phase 1 / Phase 2 source workers
 * need actual regulator-website access (PDFs in Spanish/Portuguese,
 * OCR, throttled scraping, CNPJ verification) which is not in scope
 * for the foundation PR. Wiring up real sources is per-source work
 * that lands incrementally as each regulator's data is validated.
 *
 * Order of execution per the brief §9:
 *   Week 1 — Phase 1 clean structured sources
 *     • EPA RCRA Info bulk CSV (US)               → run('epa-rcra')
 *     • IBAMA CTF consulta (BR)                   → run('ibama-ctf')
 *     • ANLA open-data API (CO)                   → run('anla')
 *     • Energy Dais cross-reference (LatAm/USGC)  → run('energy-dais')
 *
 *   Weeks 2-4 — Phase 2 LatAm regulator registries
 *     • SEMARNAT 15 rubros PDFs (MX)              → run('semarnat')
 *     • Colombian regional CARs                   → run('co-cars')
 *     • Argentine provincial Sec. de Ambiente     → run('ar-provinces')
 *     • Peru / Ecuador / Trinidad / Guyana        → run('latam-other')
 *
 *   Week 5 — Phase 3 contact enrichment via Apollo / Cognism
 *     • Tier 1 + Tier 2 by ranking score          → run('contact-enrich')
 *
 * The dispatcher returns a structured run summary so the cron logger
 * can record per-source counts without touching the workers.
 */

export type EnvServicesSource =
  | 'epa-rcra'
  | 'ibama-ctf'
  | 'anla'
  | 'energy-dais'
  | 'semarnat'
  | 'co-cars'
  | 'ar-provinces'
  | 'latam-other'
  | 'contact-enrich';

export type RunSummary = {
  source: EnvServicesSource;
  /** Status reported by the per-source worker. */
  status: 'ok' | 'skipped-not-implemented' | 'error';
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
  'epa-rcra': () => stub('epa-rcra'),
  'ibama-ctf': () => stub('ibama-ctf'),
  anla: () => stub('anla'),
  'energy-dais': () => stub('energy-dais'),
  semarnat: () => stub('semarnat'),
  'co-cars': () => stub('co-cars'),
  'ar-provinces': () => stub('ar-provinces'),
  'latam-other': () => stub('latam-other'),
  'contact-enrich': () => stub('contact-enrich'),
};

/** Run a single source by slug. */
export async function run(source: EnvServicesSource): Promise<RunSummary> {
  return WORKERS[source]();
}

/** Run every source in order. Used by a future weekly cron once
 *  Phase 1 workers are wired; aborts on hard error in any worker
 *  to avoid cascading partial state. */
export async function runAll(): Promise<RunSummary[]> {
  const summaries: RunSummary[] = [];
  for (const source of Object.keys(WORKERS) as EnvServicesSource[]) {
    const summary = await WORKERS[source]();
    summaries.push(summary);
    if (summary.status === 'error') break;
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
