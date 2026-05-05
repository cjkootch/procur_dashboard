/**
 * EPA RCRA Info ingest via ECHO. Pulls US hazardous-waste handlers
 * filtered to the petroleum-relevant NAICS set per
 * docs/environmental-services-rolodex-brief.md §4.1.
 *
 * Source: ECHO REST API (echodata.epa.gov/echo/...). The earlier
 * cut of this worker tried Envirofacts (data.epa.gov/efservice)
 * with `HD_HANDLER`/`HD_NAICS` table names — both 404 with "The
 * table is not available." Envirofacts' RCRA schema doesn't expose
 * those table names; pivoting to ECHO which is the documented,
 * stable surface for facility-level RCRA queries.
 *
 * ECHO RCRA web service: 2-step query pattern
 *   1. GET get_facilities?p_naics=<code>&output=JSON
 *      → returns { Results: { QueryID, FacilityCount, Facilities[] } }
 *      with a small first page baked in.
 *   2. GET get_qid?qid=<QueryID>&output=JSON&pagesize=N&pageno=K
 *      → paginated subsequent pages of the same result set.
 *
 * Filter: handlers whose NAICS includes one of:
 *   - 562211 — Hazardous Waste Treatment & Disposal
 *   - 562910 — Environmental Remediation Services
 *   - 562998 — All Other Miscellaneous Waste Management
 *   - 213112 — Support Activities for Oil and Gas Operations
 *
 * Each handler maps to one row in `known_entities`. Slug:
 * `epa-rcra:<EPA_HANDLER_ID>`. Re-runs UPSERT in place.
 *
 * Idempotency: same handler appearing under multiple NAICS codes is
 * collapsed at upsert (NAICS list unioned into licenseCategory).
 */
import { sql } from 'drizzle-orm';
import { db } from '@procur/db';

const ECHO_BASE = 'https://echodata.epa.gov/echo';
const TARGET_NAICS = ['562211', '562910', '562998', '213112'];
const PAGE_SIZE = 500;
const FETCH_TIMEOUT_MS = 60_000;
const PAGE_THROTTLE_MS = 500;
const MAX_PAGES_PER_NAICS = 25;

/** Subset of ECHO RCRA facility fields we care about. ECHO returns
 *  PascalCase keys with embedded underscores in some places; treat
 *  every field as optional and tolerate either casing. */
type EchoFacility = {
  RegistryID?: string;
  HandlerID?: string;
  EPAHandlerID?: string;
  FacName?: string;
  HandlerName?: string;
  FacCity?: string;
  FacState?: string;
  FacZip?: string;
  FacNAICSCodes?: string; // comma-separated string, e.g. "562211,562910"
  FacLat?: string;
  FacLong?: string;
};

type EchoFacilitiesResponse = {
  Results?: {
    QueryID?: string;
    FacilityCount?: string | number;
    Facilities?: EchoFacility[];
    PageNo?: string | number;
    Error?: string;
  };
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

async function fetchJson<T>(url: string): Promise<T> {
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
      throw new Error(`ECHO ${res.status} ${url} ${body.slice(0, 200)}`);
    }
    const text = await res.text();
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(`ECHO non-JSON ${url}: ${text.slice(0, 200)}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

/** Issue the initial query to ECHO; returns the QueryID we'll use to
 *  paginate plus the first page of facilities baked into the response. */
async function startQuery(naicsCode: string): Promise<{
  queryId: string;
  totalCount: number;
  firstPage: EchoFacility[];
}> {
  const url =
    `${ECHO_BASE}/rcra_rest_services.get_facilities` +
    `?output=JSON&p_naics=${encodeURIComponent(naicsCode)}` +
    `&responseset=${PAGE_SIZE}`;
  const json = await fetchJson<EchoFacilitiesResponse>(url);
  const r = json.Results ?? {};
  if (r.Error) throw new Error(`ECHO error: ${r.Error}`);
  if (!r.QueryID) {
    throw new Error(
      `ECHO returned no QueryID for NAICS ${naicsCode}; payload: ${JSON.stringify(json).slice(0, 200)}`,
    );
  }
  const facilities = Array.isArray(r.Facilities) ? r.Facilities : [];
  const total = Number(r.FacilityCount ?? facilities.length);
  return { queryId: r.QueryID, totalCount: total, firstPage: facilities };
}

/** Pull subsequent pages of an existing ECHO query. */
async function fetchPage(queryId: string, pageNo: number): Promise<EchoFacility[]> {
  const url =
    `${ECHO_BASE}/rcra_rest_services.get_qid` +
    `?qid=${encodeURIComponent(queryId)}&output=JSON` +
    `&responseset=${PAGE_SIZE}&pageno=${pageNo}`;
  const json = await fetchJson<EchoFacilitiesResponse>(url);
  return Array.isArray(json.Results?.Facilities) ? json.Results!.Facilities! : [];
}

function epaSlug(handlerId: string): string {
  return `epa-rcra:${handlerId.toLowerCase()}`;
}

function normalizeName(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim();
}

/** Pull the handler's EPA ID from whichever field ECHO populates. */
function handlerIdOf(f: EchoFacility): string | null {
  const id = f.HandlerID ?? f.EPAHandlerID ?? f.RegistryID;
  return id ? id.trim() : null;
}

function nameOf(f: EchoFacility): string {
  return normalizeName(f.HandlerName ?? f.FacName ?? '');
}

async function upsertHandler(
  f: EchoFacility,
  naicsCodes: Set<string>,
): Promise<'inserted' | 'updated' | 'skipped'> {
  const handlerId = handlerIdOf(f);
  const name = nameOf(f);
  if (!handlerId || !name) return 'skipped';

  const slug = epaSlug(handlerId);
  const country = 'US';
  const role = 'environmental-services';
  const categories = ['environmental-services', 'hazardous-waste'];

  // NAICS-derived waste-type inference. NAICS-only resolution is
  // coarse — Phase 1 ships this; a Phase 2 pass against the RCRA
  // waste-code table (HD_HWASTE / similar) would refine.
  const wasteTypesByNaics: Record<string, string[]> = {
    '562211': ['oily-sludge', 'tank-bottoms', 'refinery-sludge', 'spent-catalysts'],
    '562910': ['contaminated-soil', 'hydrocarbon-contaminated-water', 'crude-spill-residue'],
    '562998': [],
    '213112': ['drilling-mud-water-based', 'drill-cuttings', 'pit-waste'],
  };
  const wasteTypesHandled = Array.from(
    new Set([...naicsCodes].flatMap((n) => wasteTypesByNaics[n] ?? [])),
  );

  const capability = {
    wasteTypesHandled,
    treatmentTechnologies: [],
    mobileCapability: false,
    labCapability: false,
    countriesServed: [country],
    regulatorLicenses: [
      {
        authority: 'EPA-RCRA',
        country,
        licenseCategory: `NAICS-${[...naicsCodes].sort().join(',')}`,
        licenseNumber: handlerId,
        validUntil: null,
        sourceUrl: `https://echo.epa.gov/detailed-facility-report?fid=${encodeURIComponent(handlerId)}`,
      },
    ],
    priorOilGasClients: [],
    notes: '',
    confidenceScore: 0.7,
  };

  const cityState = [f.FacCity, f.FacState].filter(Boolean).join(', ');
  const lat = f.FacLat && Number.isFinite(Number(f.FacLat)) ? Number(f.FacLat) : null;
  const lng = f.FacLong && Number.isFinite(Number(f.FacLong)) ? Number(f.FacLong) : null;

  await db.execute(sql`
    INSERT INTO known_entities (
      slug, name, country, role, categories, tags, notes, metadata, latitude, longitude
    ) VALUES (
      ${slug},
      ${name},
      ${country},
      ${role},
      ARRAY[${sql.join(categories.map((c) => sql`${c}`), sql`, `)}]::text[],
      ARRAY['env-services', 'source:epa-rcra']::text[],
      ${cityState ? `Location: ${cityState}` : null},
      ${JSON.stringify({ environmentalServices: capability })}::jsonb,
      ${lat},
      ${lng}
    )
    ON CONFLICT (slug) DO UPDATE SET
      name        = EXCLUDED.name,
      categories  = EXCLUDED.categories,
      tags        = EXCLUDED.tags,
      notes       = EXCLUDED.notes,
      metadata    = EXCLUDED.metadata,
      latitude    = COALESCE(EXCLUDED.latitude, known_entities.latitude),
      longitude   = COALESCE(EXCLUDED.longitude, known_entities.longitude),
      updated_at  = NOW();
  `);
  return 'updated';
}

export async function runEpaRcra(): Promise<EpaRcraRunSummary> {
  const startedAt = new Date().toISOString();
  let upserted = 0;
  let skipped = 0;
  const errors: string[] = [];

  // Same handler may appear under multiple NAICS — track the union so
  // the upsert reflects the full NAICS profile.
  const naicsByHandler = new Map<string, Set<string>>();
  const allHandlers = new Map<string, EchoFacility>();

  for (const naics of TARGET_NAICS) {
    let queryId = '';
    let total = 0;
    let firstPage: EchoFacility[] = [];
    try {
      const start = await startQuery(naics);
      queryId = start.queryId;
      total = start.totalCount;
      firstPage = start.firstPage;
    } catch (err) {
      errors.push(`EPA NAICS ${naics} startQuery: ${describeError(err)}`);
      continue;
    }

    const ingestPage = (page: EchoFacility[]) => {
      for (const f of page) {
        const id = handlerIdOf(f);
        if (!id) continue;
        allHandlers.set(id, f);
        const set = naicsByHandler.get(id) ?? new Set<string>();
        set.add(naics);
        naicsByHandler.set(id, set);
      }
    };
    ingestPage(firstPage);

    if (total > firstPage.length) {
      const totalPages = Math.min(
        MAX_PAGES_PER_NAICS,
        Math.ceil(total / PAGE_SIZE),
      );
      for (let pageNo = 2; pageNo <= totalPages; pageNo += 1) {
        try {
          const page = await fetchPage(queryId, pageNo);
          if (page.length === 0) break;
          ingestPage(page);
        } catch (err) {
          errors.push(
            `EPA NAICS ${naics} page ${pageNo}: ${describeError(err)}`,
          );
          break;
        }
        await new Promise((r) => setTimeout(r, PAGE_THROTTLE_MS));
      }
      if (totalPages === MAX_PAGES_PER_NAICS && total > MAX_PAGES_PER_NAICS * PAGE_SIZE) {
        errors.push(
          `EPA NAICS ${naics}: hit page cap (${MAX_PAGES_PER_NAICS}); ` +
            `${total} total handlers, ingested first ${MAX_PAGES_PER_NAICS * PAGE_SIZE}.`,
        );
      }
    }
  }

  for (const [handlerId, facility] of allHandlers) {
    try {
      const result = await upsertHandler(
        facility,
        naicsByHandler.get(handlerId) ?? new Set(),
      );
      if (result === 'skipped') skipped += 1;
      else upserted += 1;
    } catch (err) {
      errors.push(`upsert ${handlerId}: ${describeError(err)}`);
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
