/**
 * EPA RCRA Info ingest — US hazardous waste handlers, filtered to
 * the petroleum-relevant universe per
 * docs/environmental-services-rolodex-brief.md §4.1.
 *
 * Source: EPA Envirofacts REST API
 *   https://data.epa.gov/efservice/HD_HANDLER/...
 *
 * Why Envirofacts (not the data.gov bulk CSV): the bulk CSV is the
 * full RCRA universe (hundreds of MB, ~3M rows) which we'd then
 * filter down to ~400-600 NAICS-relevant entries. The Envirofacts
 * REST API supports server-side filtering so we pull only the slice
 * we care about — a few thousand rows, manageable in a single run
 * without a temp-file step.
 *
 * Filter: handlers active in the last 24 months whose primary NAICS
 * code is in the petroleum-relevant set:
 *   - 562211 — Hazardous Waste Treatment & Disposal
 *   - 562910 — Environmental Remediation Services
 *   - 562998 — All Other Miscellaneous Waste Management
 *   - 213112 — Support Activities for Oil and Gas Operations
 *
 * Each handler maps to one row in `known_entities` with role=
 * 'environmental-services'. The `metadata.environmentalServices`
 * slot captures the structured capability shape from
 * `@procur/catalog/environmental-services-taxonomy`.
 *
 * Idempotency: keyed on `slug = 'epa-rcra:<EPA_ID>'`. Re-running
 * upserts in place — handlers that fall out of the filter (status
 * change, NAICS change) are NOT removed; they age out via the
 * regulator's own deactivation flow surfaced in
 * `regulatorLicenses[].validUntil`.
 */
import { sql } from 'drizzle-orm';
import { db } from '@procur/db';

/**
 * EPA Envirofacts has two functioning hosts that mirror the same
 * data — `data.epa.gov/efservice` (modern) and
 * `enviro.epa.gov/enviro/efservice` (legacy). We try the modern host
 * first, fall back to legacy on network failure. Both accept the same
 * URL grammar: <table-chain>/<filter>/JSON/ROWS/<start>:<end>.
 */
const EPA_BASES = [
  'https://data.epa.gov/efservice',
  'https://enviro.epa.gov/enviro/efservice',
];
const TARGET_NAICS = ['562211', '562910', '562998', '213112'];
const PAGE_SIZE = 1000;
const FETCH_TIMEOUT_MS = 60_000;
const PAGE_THROTTLE_MS = 500;

/** Subset of HD_HANDLER fields we care about. The Envirofacts JSON
 *  envelope returns lowercase column names. */
type EnvirofactsHandler = {
  handler_id: string;
  handler_name: string;
  location_street_no?: string;
  location_street1?: string;
  location_city: string;
  location_state: string;
  location_zip?: string;
  /** ISO date or RCRAInfo's MM/DD/YYYY — both observed. */
  current_record_date?: string;
  /** Federal universe code — primary NAICS comes from a sibling
   *  table HD_NAICS, which we filter on at the URL level. */
  fed_waste_generator?: string;
};

export type EpaRcraRunSummary = {
  source: 'epa-rcra';
  status: 'ok' | 'error';
  upserted: number;
  skipped: number;
  errors: string[];
  startedAt: string;
  finishedAt: string;
};

/** Unwrap nested causes from a node fetch error so the runtime
 *  surface is "fetch failed (Error: getaddrinfo ENOTFOUND data.epa.gov)"
 *  rather than just "fetch failed". */
function describeError(err: unknown): string {
  const e = err as { message?: string; cause?: unknown };
  const msg = e?.message ?? String(err);
  const cause = e?.cause;
  if (!cause) return msg;
  const causeStr =
    typeof cause === 'object' && cause != null
      ? `${(cause as Error).name ?? 'Cause'}: ${(cause as Error).message ?? JSON.stringify(cause)}`
      : String(cause);
  return `${msg} (${causeStr.slice(0, 220)})`;
}

/** Ingest one page of handlers for one NAICS code. Envirofacts URL
 *  grammar is `<base>/<table-chain>/<filter>/JSON/ROWS/<start>:<end>`.
 *  Tries each EPA host in order so a single-host outage doesn't
 *  block the run. */
async function fetchPage(
  naicsCode: string,
  rowStart: number,
  rowEnd: number,
): Promise<EnvirofactsHandler[]> {
  // Both hosts mirror the same grammar; the only difference is the
  // base prefix.
  const lastErrors: string[] = [];
  for (const base of EPA_BASES) {
    const url =
      `${base}/HD_HANDLER/HD_NAICS/NAICS_CODE/${naicsCode}` +
      `/JSON/ROWS/${rowStart}:${rowEnd}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        headers: {
          accept: 'application/json',
          'user-agent': 'ProcurEnvIngest/1.0 (+research)',
        },
        signal: ctrl.signal,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        lastErrors.push(
          `Envirofacts ${res.status} ${url} ${body.slice(0, 120)}`,
        );
        continue;
      }
      const text = await res.text();
      // Some Envirofacts hosts wrap the array in `{ "results": [...] }`
      // — handle both.
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        lastErrors.push(
          `Envirofacts non-JSON response from ${url}: ${text.slice(0, 200)}`,
        );
        continue;
      }
      const arr = Array.isArray(parsed)
        ? (parsed as EnvirofactsHandler[])
        : Array.isArray((parsed as { results?: unknown }).results)
          ? ((parsed as { results: EnvirofactsHandler[] }).results)
          : null;
      if (!arr) {
        lastErrors.push(
          `Envirofacts unexpected shape from ${url}: ${text.slice(0, 200)}`,
        );
        continue;
      }
      return arr;
    } catch (err) {
      lastErrors.push(`${url}: ${describeError(err)}`);
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(
    `all Envirofacts hosts failed for NAICS ${naicsCode} ${rowStart}-${rowEnd}: ${lastErrors.join(' | ')}`,
  );
}

/** Slugify for idempotent upsert key. Lowercase + ASCII only — handler
 *  IDs are already alphanumeric uppercase so a simple lowercase is
 *  enough. */
function epaSlug(handlerId: string): string {
  return `epa-rcra:${handlerId.toLowerCase()}`;
}

/** Best-effort name normalization: trim, collapse whitespace, drop
 *  trailing legal-form noise that pollutes alias-matching ("INC.",
 *  "LLC", "LP" all kept on the canonical name; lowercase comparison
 *  happens at query time). */
function normalizeName(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim();
}

async function upsertHandler(
  h: EnvirofactsHandler,
  naicsCodes: Set<string>,
): Promise<'inserted' | 'updated' | 'skipped'> {
  const handlerId = h.handler_id?.trim();
  const name = normalizeName(h.handler_name ?? '');
  if (!handlerId || !name) return 'skipped';

  const slug = epaSlug(handlerId);
  const country = 'US';
  const role = 'environmental-services';
  const categories = ['environmental-services', 'hazardous-waste'];

  // Capability slot — Phase 1 EPA ingest writes the structured shape
  // with what we know from RCRA Info; treatment technologies + waste
  // types are inferred from NAICS only at this layer (more specific
  // RCRA waste-codes would require a second pass against HD_HWASTE).
  const wasteTypesByNaics: Record<string, string[]> = {
    '562211': ['oily-sludge', 'tank-bottoms', 'refinery-sludge', 'spent-catalysts'],
    '562910': ['contaminated-soil', 'hydrocarbon-contaminated-water', 'crude-spill-residue'],
    '562998': [],
    '213112': ['drilling-mud-water-based', 'drill-cuttings', 'pit-waste'],
  };
  const wasteTypesHandled = Array.from(
    new Set(
      [...naicsCodes].flatMap((n) => wasteTypesByNaics[n] ?? []),
    ),
  );

  const capability = {
    wasteTypesHandled,
    treatmentTechnologies: [], // unknown at NAICS-only resolution
    mobileCapability: false, // can't infer from RCRA Info
    labCapability: false,
    countriesServed: [country],
    regulatorLicenses: [
      {
        authority: 'EPA-RCRA',
        country,
        licenseCategory: `NAICS-${[...naicsCodes].sort().join(',')}`,
        licenseNumber: handlerId,
        validUntil: null,
        sourceUrl: `https://rcrapublic.epa.gov/rcrainfoweb/action/modules/hd/handlersearchresults?epaid=${encodeURIComponent(handlerId)}`,
      },
    ],
    priorOilGasClients: [],
    notes: '',
    confidenceScore: 0.7, // single-source regulator data — entry is real but unenriched
  };

  const cityState = [h.location_city, h.location_state].filter(Boolean).join(', ');

  await db.execute(sql`
    INSERT INTO known_entities (
      slug, name, country, role, categories, tags, notes, metadata
    ) VALUES (
      ${slug},
      ${name},
      ${country},
      ${role},
      ARRAY[${sql.join(categories.map((c) => sql`${c}`), sql`, `)}]::text[],
      ARRAY['env-services', 'source:epa-rcra']::text[],
      ${cityState ? `Location: ${cityState}` : null},
      ${JSON.stringify({ environmentalServices: capability })}::jsonb
    )
    ON CONFLICT (slug) DO UPDATE SET
      name        = EXCLUDED.name,
      categories  = EXCLUDED.categories,
      tags        = EXCLUDED.tags,
      notes       = EXCLUDED.notes,
      metadata    = EXCLUDED.metadata,
      updated_at  = NOW();
  `);
  return 'updated';
}

/** Run the EPA RCRA ingest. Iterates each target NAICS code, paginates
 *  Envirofacts pages of PAGE_SIZE, and upserts each handler. Same
 *  handler appearing under multiple NAICS codes is collapsed at upsert
 *  time (re-runs union the NAICS list into licenseCategory). */
export async function runEpaRcra(): Promise<EpaRcraRunSummary> {
  const startedAt = new Date().toISOString();
  let upserted = 0;
  let skipped = 0;
  const errors: string[] = [];

  // Track handler_id → naics_codes seen so the second-pass NAICS
  // lookup doesn't have to re-fetch.
  const naicsByHandler = new Map<string, Set<string>>();
  const allHandlers = new Map<string, EnvirofactsHandler>();

  for (const naics of TARGET_NAICS) {
    let pageStart = 1;
    let pagesFetched = 0;
    while (true) {
      try {
        const page = await fetchPage(naics, pageStart, pageStart + PAGE_SIZE - 1);
        if (page.length === 0) break;
        for (const h of page) {
          if (!h.handler_id) continue;
          allHandlers.set(h.handler_id, h);
          const set = naicsByHandler.get(h.handler_id) ?? new Set<string>();
          set.add(naics);
          naicsByHandler.set(h.handler_id, set);
        }
        pagesFetched += 1;
        if (page.length < PAGE_SIZE) break;
        pageStart += PAGE_SIZE;
        await new Promise((r) => setTimeout(r, PAGE_THROTTLE_MS));
        // Cap at 50 pages per NAICS to bound cost in case a filter
        // change explodes the result set.
        if (pagesFetched >= 50) {
          errors.push(
            `EPA NAICS ${naics}: hit 50-page cap, results truncated. ` +
              `Tighten filter or raise cap.`,
          );
          break;
        }
      } catch (err) {
        errors.push(`EPA NAICS ${naics} page ${pageStart}: ${describeError(err)}`);
        break;
      }
    }
  }

  for (const [handlerId, handler] of allHandlers) {
    try {
      const result = await upsertHandler(handler, naicsByHandler.get(handlerId) ?? new Set());
      if (result === 'skipped') skipped += 1;
      else upserted += 1;
    } catch (err) {
      errors.push(`upsert ${handlerId}: ${(err as Error).message}`);
      skipped += 1;
    }
  }

  return {
    source: 'epa-rcra',
    status: errors.length > 0 && upserted === 0 ? 'error' : 'ok',
    upserted,
    skipped,
    errors,
    startedAt,
    finishedAt: new Date().toISOString(),
  };
}
