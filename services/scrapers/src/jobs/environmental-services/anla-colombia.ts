/**
 * ANLA Colombia federal environmental licensing ingest. Pulls
 * licensed operators in the petroleum-relevant sectors per
 * docs/environmental-services-rolodex-brief.md §4.3.
 *
 * STATUS: needs URL discovery. The brief assumed a CKAN portal at
 * `datos.anla.gov.co`, but DNS for that host doesn't resolve —
 * Colombia's open data is actually on the national Socrata portal
 * at `datos.gov.co`, which uses 4x4 dataset IDs (e.g. `abcd-1234`)
 * instead of named resources. The right dataset ID for the ANLA
 * "Reporte de Licencias Ambientales" needs to be discovered by
 * browsing https://www.datos.gov.co and copying the `id` from the
 * dataset's view URL.
 *
 * Set `ANLA_DATASET_ID=<4x4-id>` in env to enable. Without it the
 * worker returns `skipped-needs-discovery` and the orchestrator
 * continues past it.
 *
 * Once enabled the worker pulls the dataset via Socrata SoQL:
 *   GET https://www.datos.gov.co/resource/<id>.json?
 *     $select=...&$where=...&$limit=500&$offset=0
 *
 * Sector filter: pulls rows where the sector column matches one of
 *   - 'Hidrocarburos'
 *   - 'Residuos Peligrosos'
 *   - 'Remediación Ambiental'
 *
 * Each licensed operator → one row in `known_entities` keyed on
 * `anla:<operator-slug>`.
 */
import { sql } from 'drizzle-orm';
import { db } from '@procur/db';

/** Colombia's national open-data portal — Socrata-based. Hosts ANLA's
 *  "Reporte de Licencias Ambientales" under a 4x4 dataset ID that
 *  needs to be set via env. */
const SOCRATA_BASE = 'https://www.datos.gov.co/resource';
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
  status: 'ok' | 'error' | 'skipped-needs-discovery';
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

async function fetchPage(
  datasetId: string,
  offset: number,
  limit: number,
): Promise<AnlaLicenseRow[]> {
  const params = new URLSearchParams({
    $limit: String(limit),
    $offset: String(offset),
  });
  const url = `${SOCRATA_BASE}/${datasetId}.json?${params}`;
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
    // Socrata returns a bare array of row objects (no envelope).
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`ANLA non-JSON ${url}: ${text.slice(0, 200)}`);
    }
    if (!Array.isArray(json)) {
      throw new Error(
        `ANLA unexpected shape ${url}: ${JSON.stringify(json).slice(0, 300)}`,
      );
    }
    return json as AnlaLicenseRow[];
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
  const finishedAt = () => new Date().toISOString();

  const datasetId = process.env.ANLA_DATASET_ID?.trim();
  if (!datasetId) {
    return {
      source: 'anla',
      status: 'skipped-needs-discovery',
      upserted: 0,
      skipped: 0,
      errors: [
        'ANLA_DATASET_ID env var not set. Discover the right Socrata ' +
          'dataset ID by browsing https://www.datos.gov.co (filter to ' +
          'ANLA datasets, find the "Reporte de Licencias Ambientales" ' +
          'or sector-specific equivalent), then set the 4x4 id (e.g. ' +
          '`abcd-1234`) in env. Worker re-runs idempotently once set.',
      ],
      startedAt,
      finishedAt: finishedAt(),
    };
  }

  let upserted = 0;
  let skipped = 0;
  const errors: string[] = [];

  const allRows: AnlaLicenseRow[] = [];
  let offset = 0;
  let pages = 0;
  while (true) {
    try {
      const page = await fetchPage(datasetId, offset, PAGE_SIZE);
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
