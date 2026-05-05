/**
 * SEMARNAT Mexico federal hazardous-waste-handler ingest.
 *
 * Per docs/environmental-services-rolodex-brief.md §5.1 (post-update),
 * Mexico's federal open-data portal at datos.gob.mx publishes a
 * structured dataset for the Treatment rubro of SEMARNAT's authorized
 * waste-handler list — eliminating the OCR-and-parse step against
 * the SEMARNAT PDFs for that rubro.
 *
 * Pattern:
 *   1. CKAN package_show → discover resources for the dataset
 *   2. Pick the first CSV / JSON resource
 *   3. Try CKAN datastore_search first (records-mode, paginated)
 *   4. Fall back to direct CSV download + csv-parse if datastore
 *      isn't populated for the resource
 *   5. Map rows to known_entities upserts keyed on
 *      slug=`semarnat:<rfc-or-name-slug>`
 *
 * Dataset slug is configurable via SEMARNAT_DATASET_ID env var; the
 * brief points at `tratamiento-de-residuos-peligrosos-industriales`
 * which we use as the default. Sibling rubros (incineration,
 * transport, storage, recycling, co-processing) may need their own
 * dataset slugs — discover via datos.gob.mx and run the worker once
 * per slug as those land.
 */
import { sql } from 'drizzle-orm';
import { parse as csvParse } from 'csv-parse/sync';
import { db } from '@procur/db';

const CKAN_BASE = 'https://datos.gob.mx/api/3/action';
const DEFAULT_DATASET = 'tratamiento-de-residuos-peligrosos-industriales';
const FETCH_TIMEOUT_MS = 60_000;
const PAGE_SIZE = 500;
const PAGE_THROTTLE_MS = 500;

export type SemarnatRunSummary = {
  source: 'semarnat';
  status: 'ok' | 'error' | 'skipped-needs-discovery';
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
      throw new Error(`SEMARNAT ${res.status} ${url}: ${body.slice(0, 200)}`);
    }
    const text = await res.text();
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(`SEMARNAT non-JSON ${url}: ${text.slice(0, 200)}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

async function fetchText(url: string): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': 'ProcurEnvIngest/1.0 (+research)' },
      signal: ctrl.signal,
    });
    if (!res.ok) {
      throw new Error(`SEMARNAT ${res.status} ${url}`);
    }
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

type CkanResource = {
  id: string;
  name?: string;
  url?: string;
  format?: string;
  datastore_active?: boolean;
};

type CkanPackageResponse = {
  success?: boolean;
  result?: {
    title?: string;
    name?: string;
    resources?: CkanResource[];
  };
  error?: { message?: string; __type?: string } | string;
};

type CkanSearchResponse = {
  success?: boolean;
  result?: {
    count?: number;
    results?: Array<{
      id: string;
      name: string;
      title?: string;
      organization?: { name?: string; title?: string };
      resources?: CkanResource[];
    }>;
  };
};

type CkanDatastoreResponse = {
  success?: boolean;
  result?: {
    records?: Array<Record<string, unknown>>;
    fields?: Array<{ id: string; type: string }>;
    total?: number;
  };
};

/** Slugify a name for stable upsert keys. Strips diacritics + non-
 *  alphanumerics, lowercase, hyphenated. */
function nameSlug(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Pick the operator's display name from a CKAN row. SEMARNAT field
 *  names are unknown without testing — try several common Spanish
 *  variants. Returns null when no name field can be found. */
function pickName(row: Record<string, unknown>): string | null {
  const candidates = [
    'razon_social',
    'razon_social_o_nombre',
    'nombre',
    'nombre_empresa',
    'empresa',
    'nombre_o_razon_social',
    'denominacion',
  ];
  for (const k of candidates) {
    const v = row[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // Fallback: any string field that smells like a name (contains S.A./
  // S.A. de C.V./SA DE CV, common Mexican corporate suffixes).
  for (const v of Object.values(row)) {
    if (typeof v !== 'string') continue;
    if (/s\.?\s?a\.?( de c\.?v\.?)?/i.test(v) && v.length > 5) return v.trim();
  }
  return null;
}

/** Pick license number / authorization. */
function pickLicenseNumber(row: Record<string, unknown>): string | null {
  const candidates = [
    'numero_autorizacion',
    'num_autorizacion',
    'autorizacion',
    'numero',
    'folio',
  ];
  for (const k of candidates) {
    const v = row[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number') return String(v);
  }
  return null;
}

/** Pick rubro / category if present. */
function pickRubro(row: Record<string, unknown>): string | null {
  const candidates = ['rubro', 'rubro_autorizado', 'categoria', 'tipo'];
  for (const k of candidates) {
    const v = row[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number') return `Rubro ${v}`;
  }
  return null;
}

/** Pick state (entidad federativa). */
function pickState(row: Record<string, unknown>): string | null {
  const candidates = [
    'entidad_federativa',
    'entidad',
    'estado',
    'edo',
  ];
  for (const k of candidates) {
    const v = row[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

/** Pick validity end date (vigencia). */
function pickValidUntil(row: Record<string, unknown>): string | null {
  const candidates = [
    'vigencia_hasta',
    'vigente_hasta',
    'fecha_vencimiento',
    'vigencia',
  ];
  for (const k of candidates) {
    const v = row[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

async function upsertOperator(
  rows: Array<Record<string, unknown>>,
  rubroDefault: string,
): Promise<{ upserted: number; skipped: number; errors: string[] }> {
  const errors: string[] = [];
  let upserted = 0;
  let skipped = 0;

  // Group by operator name — same operator may appear once per
  // licensed facility in the dataset. We collapse to one rolodex
  // entry with all licenses merged.
  const byName = new Map<string, Array<Record<string, unknown>>>();
  for (const r of rows) {
    const name = pickName(r);
    if (!name) {
      skipped += 1;
      continue;
    }
    const list = byName.get(name) ?? [];
    list.push(r);
    byName.set(name, list);
  }

  for (const [name, group] of byName) {
    try {
      const slug = `semarnat:${nameSlug(name)}`;
      const country = 'MX';
      const states = Array.from(
        new Set(group.map(pickState).filter((s): s is string => Boolean(s))),
      );
      const regulatorLicenses = group.map((r) => ({
        authority: 'SEMARNAT',
        country,
        licenseCategory: pickRubro(r) ?? rubroDefault,
        licenseNumber: pickLicenseNumber(r),
        validUntil: pickValidUntil(r),
        sourceUrl: 'https://datos.gob.mx/busca/dataset/' + DEFAULT_DATASET,
      }));

      const wasteTypesByRubro: Record<string, string[]> = {
        // Rubro 5 = Tratamiento (treatment). Rubro 6 = Incineración.
        // We default to tratamiento types since the default dataset is
        // the treatment rubro; per-rubro datasets would override.
        Tratamiento: [
          'oily-sludge',
          'tank-bottoms',
          'refinery-sludge',
          'contaminated-soil',
          'spent-catalysts',
          'hydrocarbon-contaminated-water',
        ],
        Incineración: ['oily-sludge', 'refinery-sludge', 'tank-bottoms'],
        'Co-procesamiento': ['spent-catalysts', 'oily-sludge', 'refinery-sludge'],
      };
      const inferredTypes = Array.from(
        new Set(
          regulatorLicenses
            .map((l) => l.licenseCategory)
            .flatMap((cat) => {
              for (const [k, v] of Object.entries(wasteTypesByRubro)) {
                if (cat?.includes(k)) return v;
              }
              return [];
            }),
        ),
      );
      const wasteTypesHandled =
        inferredTypes.length > 0
          ? inferredTypes
          : wasteTypesByRubro.Tratamiento!; // sensible default

      const capability = {
        wasteTypesHandled,
        treatmentTechnologies: [],
        mobileCapability: false,
        labCapability: false,
        countriesServed: [country],
        regulatorLicenses,
        priorOilGasClients: [],
        notes:
          states.length > 0 ? `SEMARNAT licensed in: ${states.join(', ')}` : '',
        confidenceScore: 0.8, // regulator-sourced w/ named license
      };

      const tags = ['env-services', 'source:semarnat', 'region:latam'];
      await db.execute(sql`
        INSERT INTO known_entities (
          slug, name, country, role, categories, tags, notes, metadata
        ) VALUES (
          ${slug},
          ${name},
          ${country},
          ${'environmental-services'},
          ARRAY['environmental-services','hazardous-waste']::text[],
          ARRAY[${sql.join(tags.map((t) => sql`${t}`), sql`, `)}]::text[],
          ${capability.notes || null},
          ${JSON.stringify({ environmentalServices: capability })}::jsonb
        )
        ON CONFLICT (slug) DO UPDATE SET
          name       = EXCLUDED.name,
          categories = EXCLUDED.categories,
          tags       = EXCLUDED.tags,
          notes      = EXCLUDED.notes,
          metadata   = EXCLUDED.metadata,
          updated_at = NOW();
      `);
      upserted += 1;
    } catch (err) {
      errors.push(`upsert ${name}: ${describeError(err)}`);
      skipped += 1;
    }
  }

  return { upserted, skipped, errors };
}

/** Stream all records from a CKAN datastore-active resource via
 *  paginated datastore_search. Returns null when datastore isn't
 *  available (caller falls back to CSV download). */
async function fetchViaDatastore(
  resourceId: string,
): Promise<Array<Record<string, unknown>> | null> {
  const allRows: Array<Record<string, unknown>> = [];
  let offset = 0;
  for (let page = 0; page < 30; page += 1) {
    const url = `${CKAN_BASE}/datastore_search?resource_id=${encodeURIComponent(
      resourceId,
    )}&offset=${offset}&limit=${PAGE_SIZE}`;
    const json = await fetchJson<CkanDatastoreResponse>(url);
    if (!json.success) return null;
    const records = json.result?.records ?? [];
    if (records.length === 0) break;
    allRows.push(...records);
    if (records.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
    await new Promise((r) => setTimeout(r, PAGE_THROTTLE_MS));
  }
  return allRows;
}

/** Fall back: download the CSV directly + parse. */
async function fetchViaCsv(url: string): Promise<Array<Record<string, unknown>>> {
  const text = await fetchText(url);
  const records = csvParse(text, {
    columns: (header: string[]) =>
      header.map((h) =>
        h.trim().toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, '_'),
      ),
    skip_empty_lines: true,
    relax_column_count: true,
    bom: true,
  });
  return records as Array<Record<string, unknown>>;
}

/**
 * Fall-back: CKAN package_search to discover candidate datasets when
 * the configured slug 404s. Returns the top matches as a single
 * formatted string so the caller can dump it in the run summary —
 * the user can pick the right id and set SEMARNAT_DATASET_ID.
 */
async function discoverCandidateDatasets(query: string): Promise<string> {
  const url =
    `${CKAN_BASE}/package_search` +
    `?q=${encodeURIComponent(query)}&rows=15`;
  try {
    const json = await fetchJson<CkanSearchResponse>(url);
    const results = json.result?.results ?? [];
    if (results.length === 0) {
      return `(package_search returned 0 hits for "${query}")`;
    }
    return results
      .map((r) => {
        const org = r.organization?.title ?? r.organization?.name ?? '?';
        return `id=${r.name} | "${r.title ?? r.name}" | org=${org}`;
      })
      .join('\n  ');
  } catch (err) {
    return `(package_search failed: ${describeError(err)})`;
  }
}

export async function runSemarnat(): Promise<SemarnatRunSummary> {
  const startedAt = new Date().toISOString();
  const datasetId = process.env.SEMARNAT_DATASET_ID?.trim() || DEFAULT_DATASET;

  let resources: CkanResource[] = [];
  let packageNotFound = false;
  let packageShowError: string | null = null;
  try {
    const url = `${CKAN_BASE}/package_show?id=${encodeURIComponent(datasetId)}`;
    const json = await fetchJson<CkanPackageResponse>(url);
    if (!json.success || !json.result) {
      const errMsg =
        typeof json.error === 'string'
          ? json.error
          : (json.error?.message ?? JSON.stringify(json.error ?? json));
      packageNotFound = true;
      packageShowError = errMsg;
    } else {
      resources = json.result.resources ?? [];
    }
  } catch (err) {
    // datos.gob.mx returns 404 (not 200 + success:false) when the
    // dataset doesn't exist — fetchJson throws on !res.ok. Catch and
    // re-route to the search-fallback path below.
    const msg = describeError(err);
    if (msg.includes('404') || msg.includes('Not Found')) {
      packageNotFound = true;
      packageShowError = msg;
    } else {
      return {
        source: 'semarnat',
        status: 'error',
        upserted: 0,
        skipped: 0,
        errors: [`SEMARNAT package_show: ${msg}`],
        startedAt,
        finishedAt: new Date().toISOString(),
      };
    }
  }

  if (packageNotFound) {
    const candidates = await discoverCandidateDatasets('residuos peligrosos');
    return {
      source: 'semarnat',
      status: 'skipped-needs-discovery',
      upserted: 0,
      skipped: 0,
      errors: [
        `SEMARNAT dataset slug "${datasetId}" not found at datos.gob.mx ` +
          `(${packageShowError?.slice(0, 200) ?? '404'}). The brief's slug ` +
          `appears to have been renamed or replaced. Candidate datasets ` +
          `from CKAN package_search:\n  ${candidates}\nPick the right id ` +
          `and set SEMARNAT_DATASET_ID env to enable the worker.`,
      ],
      startedAt,
      finishedAt: new Date().toISOString(),
    };
  }

  // Pick the first CSV / JSON / XLSX resource. Most datos.gob.mx
  // datasets ship a single tabular resource per dataset; fall back
  // to whichever has datastore_active=true if that's all we have.
  const resource =
    resources.find((r) => /csv|json|xls/i.test(r.format ?? '')) ??
    resources.find((r) => r.datastore_active) ??
    resources[0];
  if (!resource) {
    return {
      source: 'semarnat',
      status: 'error',
      upserted: 0,
      skipped: 0,
      errors: [`SEMARNAT dataset "${datasetId}" has no resources.`],
      startedAt,
      finishedAt: new Date().toISOString(),
    };
  }

  const errors: string[] = [];
  let rows: Array<Record<string, unknown>> | null = null;

  // Try datastore first (paginated, structured), fall back to CSV.
  if (resource.datastore_active && resource.id) {
    try {
      rows = await fetchViaDatastore(resource.id);
    } catch (err) {
      errors.push(`SEMARNAT datastore_search: ${describeError(err)}`);
    }
  }
  if (!rows && resource.url) {
    try {
      rows = await fetchViaCsv(resource.url);
    } catch (err) {
      errors.push(`SEMARNAT csv download (${resource.url}): ${describeError(err)}`);
    }
  }
  if (!rows) {
    return {
      source: 'semarnat',
      status: 'error',
      upserted: 0,
      skipped: 0,
      errors: errors.length > 0 ? errors : ['SEMARNAT: no rows pulled'],
      startedAt,
      finishedAt: new Date().toISOString(),
    };
  }

  const result = await upsertOperator(rows, 'Rubro 5 - Tratamiento');
  errors.push(...result.errors);

  // Diagnostic when 0 ingested — surface the first row's keys so the
  // next iteration can tighten the column-name picker.
  if (result.upserted === 0 && rows.length > 0) {
    const sample = rows[0]!;
    errors.push(
      `SEMARNAT pulled ${rows.length} rows, 0 upserted. First-row keys: ` +
        `${Object.keys(sample).slice(0, 20).join(',')}. Update pickName/` +
        'pickLicenseNumber/pickState in semarnat-mexico.ts to match.',
    );
  }

  return {
    source: 'semarnat',
    status: errors.length > 0 && result.upserted === 0 ? 'error' : 'ok',
    upserted: result.upserted,
    skipped: result.skipped,
    errors,
    startedAt,
    finishedAt: new Date().toISOString(),
  };
}
