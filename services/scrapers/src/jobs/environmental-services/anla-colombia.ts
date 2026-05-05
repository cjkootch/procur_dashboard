/**
 * ANLA Colombia federal environmental licensing ingest.
 *
 * Per brief §4.3 v2, ANLA's open data lives on ArcGIS at:
 *   - Hub portal: https://datosabiertos-anla.hub.arcgis.com (browse)
 *   - Feature-server REST: https://portalsig.anla.gov.co/publico/rest/services/OPENDATA/
 *
 * The brief pointed at one specific layer (Áreas Licenciadas
 * Hidrocarburos) but its licensee is the oil company holding the
 * project license, not the env-services operator we want. Our
 * targets are sibling layers covering Residuos Peligrosos and
 * Remediación Ambiental — those licensees ARE env-services operators.
 *
 * Strategy: walk the ArcGIS service catalog at /OPENDATA?f=json,
 * pick the layers whose name matches our sector keywords, and
 * paginate each layer's features via /query. Each feature →
 * upsert. Service-discovery is the standout reason we use this
 * path: if ANLA renames or adds layers, the worker auto-picks them
 * up without code changes.
 *
 * Field names inside ArcGIS feature attributes are unknown without
 * testing — defensive picker (same shape as SEMARNAT) tries
 * common Spanish column names and surfaces unmatched-key
 * diagnostics in the run summary.
 *
 * Idempotency: keyed on `slug = 'anla:<operator-slug>'`. Same
 * operator across multiple sibling layers merges into one rolodex
 * entry with full license profile.
 */
import { sql } from 'drizzle-orm';
import { db } from '@procur/db';

const ANLA_BASE = 'https://portalsig.anla.gov.co/publico/rest/services';
const SERVICE_FOLDER = 'OPENDATA';
const FETCH_TIMEOUT_MS = 60_000;
const PAGE_SIZE = 500;
const PAGE_THROTTLE_MS = 500;
const MAX_PAGES_PER_LAYER = 30;

/**
 * Layer-name keyword filter. We pick MapServer / FeatureServer
 * layers whose name (case-insensitive) contains one of these
 * fragments — covers Residuos Peligrosos / Remediación variants
 * without committing to exact strings (ArcGIS layer names drift).
 */
const RELEVANT_LAYER_KEYWORDS = [
  'residuo',
  'remediac',
  'peligroso',
  'remediation',
];

/** Layer-name keywords we EXCLUDE — hydrocarbon project layers
 *  whose licensee is the oil company, not an env-services operator. */
const EXCLUDED_LAYER_KEYWORDS = [
  'hidrocarbur',
  'mineria',
  'mineral',
  'energia',
  'electric',
];

export type AnlaRunSummary = {
  source: 'anla';
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
      throw new Error(`ANLA ${res.status} ${url}: ${body.slice(0, 200)}`);
    }
    const text = await res.text();
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(`ANLA non-JSON ${url}: ${text.slice(0, 200)}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

type ArcGisCatalog = {
  services?: Array<{ name: string; type: 'MapServer' | 'FeatureServer' | string }>;
  folders?: string[];
  error?: { message?: string };
};

type ArcGisService = {
  layers?: Array<{ id: number; name: string; type?: string }>;
  tables?: Array<{ id: number; name: string }>;
  error?: { message?: string };
};

type ArcGisQuery = {
  features?: Array<{ attributes: Record<string, unknown> }>;
  exceededTransferLimit?: boolean;
  error?: { code?: number; message?: string };
};

/** Walk the OPENDATA folder catalog → discover relevant MapServer
 *  layers across all services in the folder. Returns layer URLs
 *  ready to query. */
async function discoverLayers(): Promise<{
  picked: Array<{ url: string; serviceName: string; layerName: string }>;
  rejectedAll: string[];
}> {
  const folderUrl = `${ANLA_BASE}/${SERVICE_FOLDER}?f=json`;
  const catalog = await fetchJson<ArcGisCatalog>(folderUrl);
  if (catalog.error) {
    throw new Error(`ANLA folder ${folderUrl}: ${catalog.error.message}`);
  }
  const services = catalog.services ?? [];
  const picked: Array<{ url: string; serviceName: string; layerName: string }> = [];
  const rejectedAll: string[] = [];
  for (const svc of services) {
    if (svc.type !== 'MapServer' && svc.type !== 'FeatureServer') continue;
    const svcUrl = `${ANLA_BASE}/${svc.name}/${svc.type}?f=json`;
    let info: ArcGisService;
    try {
      info = await fetchJson<ArcGisService>(svcUrl);
    } catch {
      continue;
    }
    if (info.error) continue;
    const layers = [...(info.layers ?? []), ...(info.tables ?? [])];
    for (const layer of layers) {
      const lower = layer.name.toLowerCase();
      const isExcluded = EXCLUDED_LAYER_KEYWORDS.some((k) => lower.includes(k));
      if (isExcluded) continue;
      const isRelevant = RELEVANT_LAYER_KEYWORDS.some((k) => lower.includes(k));
      if (!isRelevant) {
        rejectedAll.push(`${svc.name}/${layer.id}=${layer.name}`);
        continue;
      }
      picked.push({
        url: `${ANLA_BASE}/${svc.name}/${svc.type}/${layer.id}`,
        serviceName: svc.name,
        layerName: layer.name,
      });
    }
    await new Promise((r) => setTimeout(r, PAGE_THROTTLE_MS));
  }
  return { picked, rejectedAll };
}

/** Page through one layer's features. */
async function fetchLayerFeatures(
  layerUrl: string,
): Promise<Array<Record<string, unknown>>> {
  const allRecords: Array<Record<string, unknown>> = [];
  let offset = 0;
  for (let page = 0; page < MAX_PAGES_PER_LAYER; page += 1) {
    const url =
      `${layerUrl}/query` +
      `?where=1%3D1&outFields=*&returnGeometry=false&f=json` +
      `&resultOffset=${offset}&resultRecordCount=${PAGE_SIZE}`;
    const json = await fetchJson<ArcGisQuery>(url);
    if (json.error) {
      throw new Error(`ANLA query ${url}: ${json.error.message}`);
    }
    const features = json.features ?? [];
    if (features.length === 0) break;
    for (const f of features) allRecords.push(f.attributes);
    if (!json.exceededTransferLimit && features.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
    await new Promise((r) => setTimeout(r, PAGE_THROTTLE_MS));
  }
  return allRecords;
}

/** Slug helper (same as SEMARNAT). */
function nameSlug(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Field pickers — ANLA ArcGIS attribute keys are unknown w/o
 *  testing; try the most common Spanish + ANLA-specific variants
 *  and surface unmatched-key diagnostics from the caller. */
function pickName(row: Record<string, unknown>): string | null {
  const candidates = [
    'titular',
    'nombre_titular',
    'razon_social',
    'beneficiario',
    'empresa',
    'nombre_empresa',
    'nombre',
    'operador',
  ];
  for (const k of candidates) {
    const v = row[k] ?? row[k.toUpperCase()];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

function pickLicense(row: Record<string, unknown>): string | null {
  const candidates = [
    'numero_resolucion',
    'num_resolucion',
    'resolucion',
    'expediente',
    'numero_expediente',
    'no_acto',
  ];
  for (const k of candidates) {
    const v = row[k] ?? row[k.toUpperCase()];
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number') return String(v);
  }
  return null;
}

function pickSector(row: Record<string, unknown>, layerName: string): string {
  const candidates = ['sector', 'tipo_proyecto', 'subsector', 'actividad'];
  for (const k of candidates) {
    const v = row[k] ?? row[k.toUpperCase()];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return layerName;
}

function pickValidUntil(row: Record<string, unknown>): string | null {
  const candidates = ['vigencia', 'vigente_hasta', 'fecha_vencimiento', 'fecha_fin'];
  for (const k of candidates) {
    const v = row[k] ?? row[k.toUpperCase()];
    if (typeof v === 'string' && v.trim()) return v.trim();
    // ArcGIS often stores dates as epoch ms.
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
      try {
        return new Date(v).toISOString().slice(0, 10);
      } catch {
        return null;
      }
    }
  }
  return null;
}

async function upsertLayerRows(
  layerName: string,
  rows: Array<Record<string, unknown>>,
): Promise<{ upserted: number; skipped: number; errors: string[] }> {
  const errors: string[] = [];
  let upserted = 0;
  let skipped = 0;

  // Group by operator (titular) — same operator may appear across
  // many features (one per licensed area).
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

  const wasteTypesByLayer: Record<string, string[]> = {};
  if (/residuo|peligroso/i.test(layerName)) {
    wasteTypesByLayer[layerName] = [
      'oily-sludge',
      'refinery-sludge',
      'spent-catalysts',
      'contaminated-soil',
      'tank-bottoms',
    ];
  }
  if (/remediac/i.test(layerName)) {
    wasteTypesByLayer[layerName] = [
      'contaminated-soil',
      'hydrocarbon-contaminated-water',
      'crude-spill-residue',
    ];
  }
  const wasteTypes = wasteTypesByLayer[layerName] ?? [];

  for (const [name, group] of byName) {
    try {
      const slug = `anla:${nameSlug(name)}`;
      const country = 'CO';
      const regulatorLicenses = group.map((r) => ({
        authority: 'ANLA',
        country,
        licenseCategory: pickSector(r, layerName),
        licenseNumber: pickLicense(r),
        validUntil: pickValidUntil(r),
        sourceUrl: `${ANLA_BASE}/${SERVICE_FOLDER}/`,
      }));

      const capability = {
        wasteTypesHandled: wasteTypes,
        treatmentTechnologies: [],
        mobileCapability: false,
        labCapability: false,
        countriesServed: [country],
        regulatorLicenses,
        priorOilGasClients: [],
        notes: `ANLA license sourced from layer "${layerName}".`,
        confidenceScore: 0.8,
      };

      const tags = ['env-services', 'source:anla', 'region:latam'];
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
          ${capability.notes},
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

export async function runAnla(): Promise<AnlaRunSummary> {
  const startedAt = new Date().toISOString();
  let upserted = 0;
  let skipped = 0;
  const errors: string[] = [];

  let pickedLayers: Array<{ url: string; serviceName: string; layerName: string }> = [];
  let rejectedAll: string[] = [];
  try {
    const discovered = await discoverLayers();
    pickedLayers = discovered.picked;
    rejectedAll = discovered.rejectedAll;
  } catch (err) {
    return {
      source: 'anla',
      status: 'error',
      upserted: 0,
      skipped: 0,
      errors: [`ANLA service discovery: ${describeError(err)}`],
      startedAt,
      finishedAt: new Date().toISOString(),
    };
  }

  if (pickedLayers.length === 0) {
    // Nothing matched the keyword filter — surface what we DID find
    // so the next iteration can adjust the keyword set.
    return {
      source: 'anla',
      status: 'error',
      upserted: 0,
      skipped: 0,
      errors: [
        `ANLA: 0 layers matched env-services keywords. Layers ` +
          `discovered (rejected): ${rejectedAll.slice(0, 30).join(' | ')}` +
          (rejectedAll.length > 30 ? ` (+${rejectedAll.length - 30} more)` : '') +
          `. Adjust RELEVANT_LAYER_KEYWORDS in anla-colombia.ts.`,
      ],
      startedAt,
      finishedAt: new Date().toISOString(),
    };
  }

  for (const layer of pickedLayers) {
    let rows: Array<Record<string, unknown>> = [];
    try {
      rows = await fetchLayerFeatures(layer.url);
    } catch (err) {
      errors.push(`ANLA layer ${layer.layerName}: ${describeError(err)}`);
      continue;
    }
    if (rows.length === 0) continue;
    const result = await upsertLayerRows(layer.layerName, rows);
    upserted += result.upserted;
    skipped += result.skipped;
    errors.push(...result.errors);
    // Diagnostic when 0 upserted from non-empty rows: surface keys
    // so the picker can be tightened.
    if (result.upserted === 0 && rows.length > 0) {
      const sample = rows[0]!;
      errors.push(
        `ANLA layer ${layer.layerName}: pulled ${rows.length} rows, 0 upserted. ` +
          `First-row keys: ${Object.keys(sample).slice(0, 20).join(',')}. ` +
          `Update pickName/pickLicense in anla-colombia.ts.`,
      );
    }
  }

  return {
    source: 'anla',
    status: errors.length > 0 && upserted === 0 ? 'error' : 'ok',
    upserted,
    skipped,
    errors,
    startedAt,
    finishedAt: new Date().toISOString(),
  };
}
