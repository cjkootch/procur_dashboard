/**
 * EPA RCRA Info ingest — STATUS: needs-discovery (bulk-download path).
 *
 * History: tried ECHO REST API (`rcra_rest_services.get_facilities`)
 * with multiple param-name variants (`p_naics`, `p_ncs`, `p_un`).
 * Each one was silently ignored — ECHO returned the full ~1.59M-row
 * RCRA universe and tripped its queryset-limit error. The endpoint
 * exists and accepts JSON, but the param convention for this
 * service isn't matching what we sent.
 *
 * Per docs/environmental-services-rolodex-brief.md §4.1 (post-update),
 * the canonical paths are EPA-direct bulk downloads, not the REST
 * API:
 *
 *   1. rcrapublic.epa.gov/rcra-public-export/
 *      → weekly Monday refresh, fixed-format files for the full
 *        RCRAInfo module set (HD_HANDLER, HD_HANDLER_NAICS, etc.)
 *      → most authoritative; canonical schema documented by EPA.
 *
 *   2. echo.epa.gov/tools/data-downloads/rcrainfo-download-summary
 *      → ECHO's CSV mirror of the same data, easier to parse
 *        (CSV vs fixed-format), with documented data dictionary.
 *      → typically: download a zip, unzip, parse CSV, filter.
 *
 * Implementation pattern for the next iteration:
 *
 *   • undici stream + a small zip extractor (e.g. `unzipper` or
 *     `adm-zip` — neither in deps yet, would need to add)
 *   • csv-parse (already in deps) for streaming row-by-row parse
 *   • Filter rows where FAC_NAICS_CODES overlaps {562211, 562910,
 *     562998, 213112}
 *   • Upsert each as known_entities row (slug='epa-rcra:<EPA_ID>')
 *
 * Until that rewrite lands, this worker returns
 * `skipped-needs-discovery`. The orchestrator continues past it;
 * curated-seed carries US coverage in the meantime.
 */

export type EpaRcraRunSummary = {
  source: 'epa-rcra';
  status: 'ok' | 'error' | 'skipped-needs-discovery';
  upserted: number;
  skipped: number;
  errors: string[];
  startedAt: string;
  finishedAt: string;
};

export async function runEpaRcra(): Promise<EpaRcraRunSummary> {
  const ts = new Date().toISOString();
  return {
    source: 'epa-rcra',
    status: 'skipped-needs-discovery',
    upserted: 0,
    skipped: 0,
    errors: [
      'EPA RCRA needs the bulk-download path, not the ECHO REST API. ' +
        'Per docs/environmental-services-rolodex-brief.md §4.1, the ' +
        'canonical sources are: ' +
        '(1) https://rcrapublic.epa.gov/rcra-public-export/ — weekly ' +
        'Monday refresh, fixed-format module files (HD_HANDLER, ' +
        'HD_HANDLER_NAICS), most authoritative. ' +
        '(2) https://echo.epa.gov/tools/data-downloads/rcrainfo-download-summary ' +
        '— ECHO CSV mirror, easier to parse. ' +
        'Implementation pattern: download zip → unzip → stream-parse CSV ' +
        '(csv-parse already in deps; add unzipper or adm-zip) → filter ' +
        'FAC_NAICS_CODES overlap with {562211, 562910, 562998, 213112} ' +
        '→ upsert with slug=`epa-rcra:<EPA_ID>`. The earlier ECHO REST ' +
        'attempts (p_naics / p_ncs / p_un) all hit the queryset-limit ' +
        'error because filter params were silently ignored.',
    ],
    startedAt: ts,
    finishedAt: ts,
  };
}
