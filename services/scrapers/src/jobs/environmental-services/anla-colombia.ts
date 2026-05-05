/**
 * ANLA Colombia federal environmental licensing ingest. Pulls
 * licensed operators in the petroleum-relevant sectors per
 * docs/environmental-services-rolodex-brief.md §4.3.
 *
 * Source: ANLA open-data portal at https://datos.anla.gov.co
 *   - Resource catalog: /api/3/action/package_list (CKAN-shaped)
 *   - Per-resource records: /api/3/action/datastore_search
 *
 * Sector filter: ANLA publishes the "Reporte de Licencias
 * Ambientales" with a `sector` column. We narrow to:
 *   - 'Hidrocarburos' (oil and gas)
 *   - 'Residuos Peligrosos' (hazardous waste)
 *   - 'Remediación Ambiental' (environmental remediation)
 *
 * Each licensed operator → one row in `known_entities`. Resolution
 * is operator name (sometimes parent company), country=CO, role=
 * 'environmental-services'. Federal-level licenses only; regional
 * CARs ship in a sibling worker (`co-cars.ts`, deferred).
 *
 * Idempotency: keyed on `slug = 'anla:<operator-slug>'` where the
 * operator-slug is a normalized lowercase form of the company name.
 * Same operator with multiple resolutions surfaces as one rolodex
 * entry; the licenses array merges across resolutions.
 */
import { sql } from 'drizzle-orm';
import { db } from '@procur/db';

const ANLA_BASE = 'https://datos.anla.gov.co';
/** CKAN-shaped resource id for the consolidated environmental
 *  licenses dataset. ANLA renames resources occasionally — if this
 *  404s, the worker logs and a follow-up updates the id. */
const LICENSES_RESOURCE = 'reporte-licencias-ambientales';
const FETCH_TIMEOUT_MS = 60_000;
const PAGE_SIZE = 500;
const PAGE_THROTTLE_MS = 750;

type AnlaLicenseRow = {
  /** Resolution number (resolución de otorgamiento). */
  numero_resolucion?: string;
  /** ISO date of resolution. */
  fecha_resolucion?: string;
  /** Operator / titular (the company holding the license). */
  titular?: string;
  /** Sector taxonomy. */
  sector?: string;
  /** Activity scope text. */
  actividad?: string;
  /** Geographic scope (departamento + municipio comma-joined). */
  ubicacion?: string;
  /** Validity end date — null when license is open-ended. */
  vigente_hasta?: string;
  /** Status — 'Vigente' (valid) | 'Suspendida' | 'Archivada'. */
  estado?: string;
};

const TARGET_SECTORS = [
  'Hidrocarburos',
  'Residuos Peligrosos',
  'Remediación Ambiental',
];

export type AnlaRunSummary = {
  source: 'anla';
  status: 'ok' | 'error';
  upserted: number;
  skipped: number;
  errors: string[];
  startedAt: string;
  finishedAt: string;
};

/** Unwrap nested causes from a node fetch error so the run summary
 *  surfaces "fetch failed (Error: getaddrinfo ENOTFOUND ...)" rather
 *  than just "fetch failed". */
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

async function fetchPage(offset: number, limit: number): Promise<AnlaLicenseRow[]> {
  const params = new URLSearchParams({
    resource_id: LICENSES_RESOURCE,
    offset: String(offset),
    limit: String(limit),
  });
  const url = `${ANLA_BASE}/api/3/action/datastore_search?${params}`;
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
    let json: {
      success?: boolean;
      result?: { records?: AnlaLicenseRow[] };
      error?: { message?: string } | string;
    };
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`ANLA non-JSON ${url}: ${text.slice(0, 200)}`);
    }
    if (!json.success) {
      const errMsg =
        typeof json.error === 'string'
          ? json.error
          : (json.error?.message ?? JSON.stringify(json.error ?? json));
      throw new Error(`ANLA error for ${url}: ${errMsg.slice(0, 300)}`);
    }
    return json.result?.records ?? [];
  } finally {
    clearTimeout(timer);
  }
}

function operatorSlug(name: string): string {
  const normalized = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // strip diacritics (Petróleos → petroleos)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `anla:${normalized}`;
}

/** Group rows by operator (titular) — the same operator typically
 *  appears once per resolution, and a single rolodex entry should
 *  hold all of them. */
function groupByOperator(rows: AnlaLicenseRow[]): Map<string, AnlaLicenseRow[]> {
  const out = new Map<string, AnlaLicenseRow[]>();
  for (const r of rows) {
    const titular = r.titular?.trim();
    if (!titular) continue;
    if (!r.sector || !TARGET_SECTORS.includes(r.sector)) continue;
    const list = out.get(titular) ?? [];
    list.push(r);
    out.set(titular, list);
  }
  return out;
}

async function upsertOperator(
  titular: string,
  rows: AnlaLicenseRow[],
): Promise<'updated' | 'skipped'> {
  if (rows.length === 0) return 'skipped';
  const slug = operatorSlug(titular);
  const country = 'CO';

  // Map ANLA sectors to our waste-type taxonomy.
  const wasteTypesBySector: Record<string, string[]> = {
    Hidrocarburos: [
      'oily-sludge',
      'tank-bottoms',
      'pit-waste',
      'crude-spill-residue',
      'produced-water-sludge',
    ],
    'Residuos Peligrosos': [
      'oily-sludge',
      'refinery-sludge',
      'spent-catalysts',
      'contaminated-soil',
    ],
    'Remediación Ambiental': [
      'contaminated-soil',
      'hydrocarbon-contaminated-water',
      'crude-spill-residue',
    ],
  };
  const sectors = Array.from(new Set(rows.map((r) => r.sector!).filter(Boolean)));
  const wasteTypesHandled = Array.from(
    new Set(sectors.flatMap((s) => wasteTypesBySector[s] ?? [])),
  );

  const regulatorLicenses = rows.map((r) => ({
    authority: 'ANLA',
    country,
    licenseCategory: r.sector ?? 'Unknown',
    licenseNumber: r.numero_resolucion ?? null,
    validUntil: r.vigente_hasta ?? null,
    sourceUrl: 'https://datos.anla.gov.co/',
  }));

  const capability = {
    wasteTypesHandled,
    treatmentTechnologies: [], // not in ANLA payload
    mobileCapability: false,
    labCapability: false,
    countriesServed: [country],
    regulatorLicenses,
    priorOilGasClients: [],
    notes:
      sectors.length > 0
        ? `ANLA federal licensure: ${sectors.join(', ')}`
        : '',
    // Higher than EPA's 0.7 because ANLA licenses are explicitly
    // tied to a resolution number + activity scope + validity dates,
    // which is stronger evidence than a NAICS-code-only filter.
    confidenceScore: 0.8,
  };

  await db.execute(sql`
    INSERT INTO known_entities (
      slug, name, country, role, categories, tags, notes, metadata
    ) VALUES (
      ${slug},
      ${titular},
      ${country},
      ${'environmental-services'},
      ARRAY['environmental-services','hazardous-waste']::text[],
      ARRAY['env-services','source:anla','region:latam']::text[],
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
  return 'updated';
}

export async function runAnla(): Promise<AnlaRunSummary> {
  const startedAt = new Date().toISOString();
  let upserted = 0;
  let skipped = 0;
  const errors: string[] = [];

  const allRows: AnlaLicenseRow[] = [];
  let offset = 0;
  let pages = 0;
  while (true) {
    try {
      const page = await fetchPage(offset, PAGE_SIZE);
      if (page.length === 0) break;
      allRows.push(...page);
      pages += 1;
      if (page.length < PAGE_SIZE) break;
      offset += PAGE_SIZE;
      await new Promise((r) => setTimeout(r, PAGE_THROTTLE_MS));
      if (pages >= 30) {
        errors.push('ANLA: 30-page cap hit, results truncated');
        break;
      }
    } catch (err) {
      errors.push(`ANLA page offset=${offset}: ${describeError(err)}`);
      break;
    }
  }

  const grouped = groupByOperator(allRows);
  for (const [titular, rows] of grouped) {
    try {
      const result = await upsertOperator(titular, rows);
      if (result === 'skipped') skipped += 1;
      else upserted += 1;
    } catch (err) {
      errors.push(`upsert ${titular}: ${(err as Error).message}`);
      skipped += 1;
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
