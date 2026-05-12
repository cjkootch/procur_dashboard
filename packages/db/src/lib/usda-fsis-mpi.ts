/**
 * USDA FSIS Meat, Poultry and Egg Product Inspection Directory ingest.
 *
 * Library function shared by:
 *   - CLI: `pnpm --filter @procur/db ingest-usda-fsis-mpi` (local run)
 *   - Admin route: `/api/admin/seed/usda-fsis-mpi` (remote one-shot)
 *
 * Source: FSIS publishes the MPI Directory as a CSV quarterly at
 * https://www.fsis.usda.gov/inspection/establishments/meat-poultry-and-egg-product-inspection-directory
 *
 * The CSV's exact URL changes with each quarterly drop (date-stamped
 * subdir). This module:
 *   1. Accepts `MPI_CSV_URL` env override (set this when running)
 *   2. Otherwise scrapes the FSIS catalog page for the latest
 *      "Establishment Number" CSV link and uses that
 *
 * Idempotent on establishment_number (primary key). Re-running updates
 * mutable fields (address, activities, species, etc.) but never
 * resets enrichment columns (apollo_org_id, capacity_*, product_*)
 * which are owned by separate enrichment pipelines.
 */

import { parse as parseCsv } from 'csv-parse/sync';
import { sql } from 'drizzle-orm';
import { neon } from '@neondatabase/serverless';
import { drizzle, type drizzle as drizzleType } from 'drizzle-orm/neon-http';
import * as cheerio from 'cheerio';
import * as schema from '../schema';

const FSIS_CATALOG_PAGE =
  'https://www.fsis.usda.gov/inspection/establishments/meat-poultry-and-egg-product-inspection-directory';

type Db = ReturnType<typeof drizzleType<typeof schema>>;

/**
 * Field names in the FSIS CSV. FSIS occasionally tweaks the casing /
 * spacing; the parser is case-insensitive via lookup helpers below.
 */
type MpiCsvRow = Record<string, string>;

export interface IngestResult {
  csvUrl: string;
  rowsParsed: number;
  rowsInserted: number;
  rowsUpdated: number;
  rowsSkipped: number;
  errors: number;
}

/**
 * Best-effort discovery of the current MPI Directory CSV URL by
 * scraping the FSIS catalog page. Looks for any <a> with text matching
 * "Establishment Number" pointing at a `.csv` resource. Returns null
 * when nothing matches — caller must set MPI_CSV_URL explicitly.
 */
async function discoverMpiCsvUrl(): Promise<string | null> {
  try {
    const resp = await fetch(FSIS_CATALOG_PAGE, {
      headers: {
        Accept: 'text/html',
        'User-Agent': 'procur-fsis-ingest/0.1 (+https://procur.app)',
      },
    });
    if (!resp.ok) return null;
    const html = await resp.text();
    const $ = cheerio.load(html);
    let found: string | null = null;
    $('a[href$=".csv"]').each((_, el) => {
      if (found) return;
      const href = $(el).attr('href') ?? '';
      const text = $(el).text().toLowerCase();
      if (
        text.includes('establishment number') ||
        href.toLowerCase().includes('mpi_directory_by_establishment_number')
      ) {
        found = href.startsWith('http')
          ? href
          : `https://www.fsis.usda.gov${href}`;
      }
    });
    return found;
  } catch {
    return null;
  }
}

function pickField(row: MpiCsvRow, ...candidates: string[]): string | null {
  // Case-insensitive lookup; tolerate FSIS column-naming drift.
  const lc: Record<string, string> = {};
  for (const [k, v] of Object.entries(row)) lc[k.toLowerCase()] = v;
  for (const name of candidates) {
    const v = lc[name.toLowerCase()];
    if (v != null && String(v).trim().length > 0) return String(v).trim();
  }
  return null;
}

/**
 * Split a multi-value FSIS field (space- / comma- / semicolon-separated)
 * into a normalized lowercase array. Drops empty entries.
 */
function splitMulti(value: string | null): string[] {
  if (!value) return [];
  return value
    .split(/[,;|\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
}

function normalizeActivity(raw: string): string | null {
  const t = raw.toLowerCase();
  if (t.includes('slaughter')) return 'slaughter';
  if (t.includes('processing')) return 'processing';
  if (t.includes('plant')) return 'plant';
  if (t.includes('import')) return 'import';
  if (t.includes('identification')) return 'identification';
  if (t.includes('retail')) return 'retail';
  return t || null;
}

function normalizeSpecies(raw: string): string | null {
  const t = raw.toLowerCase();
  if (t.includes('swine') || t.includes('hog') || t.includes('pork'))
    return 'swine';
  if (t.includes('cattle') || t.includes('beef')) return 'cattle';
  if (t.includes('sheep') || t.includes('lamb')) return 'sheep';
  if (t.includes('goat')) return 'goat';
  if (t.includes('equine') || t.includes('horse')) return 'equine';
  if (t.includes('poultry') || t.includes('chicken') || t.includes('turkey'))
    return 'poultry';
  if (t.includes('egg')) return 'egg';
  if (t.includes('bison')) return 'bison';
  if (t.includes('rabbit')) return 'rabbit';
  if (t.includes('ratite') || t.includes('ostrich') || t.includes('emu'))
    return 'ratite';
  return t || null;
}

function normalizeGrant(raw: string): string | null {
  const t = raw.toLowerCase();
  if (t.includes('federal')) return 'federal';
  if (t.includes('state')) return 'state';
  if (t.includes('talmadge')) return 'talmadge-aiken';
  return t || null;
}

function parseFloatSafe(s: string | null): number | null {
  if (!s) return null;
  const n = Number.parseFloat(s.replace(/[, ]/g, ''));
  return Number.isFinite(n) ? n : null;
}

interface MappedRow {
  establishmentNumber: string;
  legalName: string;
  dbaName: string | null;
  street: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  county: string | null;
  phone: string | null;
  activities: string[];
  species: string[];
  grants: string[];
  latitude: string | null;
  longitude: string | null;
  rawPayload: Record<string, unknown>;
}

function mapRow(row: MpiCsvRow): MappedRow | null {
  const establishmentNumber = pickField(
    row,
    'Establishment Number',
    'Establishment ID',
    'EstablishmentNumber',
    'EstNum',
  );
  const legalName = pickField(
    row,
    'Establishment Name',
    'Company Name',
    'Legal Name',
    'EstablishmentName',
  );
  if (!establishmentNumber || !legalName) return null;

  const activitiesRaw = pickField(row, 'Activities', 'Activity', 'Operations');
  const speciesRaw = pickField(row, 'Species', 'Species List', 'Animal');
  const grantsRaw = pickField(
    row,
    'Inspection Grants',
    'Grants',
    'Inspection Type',
  );

  const lat = parseFloatSafe(pickField(row, 'Latitude', 'Lat'));
  const lng = parseFloatSafe(pickField(row, 'Longitude', 'Lon', 'Lng'));

  return {
    establishmentNumber,
    legalName,
    dbaName: pickField(row, 'DBA Name', 'DBA', 'Doing Business As'),
    street: pickField(row, 'Street', 'Street Address', 'Address'),
    city: pickField(row, 'City'),
    state: pickField(row, 'State', 'St'),
    zip: pickField(row, 'Zip', 'ZIP', 'Zip Code', 'Postal Code'),
    county: pickField(row, 'County'),
    phone: pickField(row, 'Phone', 'Phone Number'),
    activities: splitMulti(activitiesRaw)
      .map(normalizeActivity)
      .filter((v): v is string => v != null),
    species: splitMulti(speciesRaw)
      .map(normalizeSpecies)
      .filter((v): v is string => v != null),
    grants: splitMulti(grantsRaw)
      .map(normalizeGrant)
      .filter((v): v is string => v != null),
    latitude: lat != null ? String(lat) : null,
    longitude: lng != null ? String(lng) : null,
    rawPayload: row as Record<string, unknown>,
  };
}

/**
 * Fetch + parse + upsert the MPI Directory.
 *
 * @param db Drizzle Neon-HTTP client.
 * @param explicitCsvUrl When set, overrides discovery (and the
 *   MPI_CSV_URL env var). Useful for testing against a pinned CSV.
 */
export async function fetchAndIngestMpiDirectory(
  db: Db,
  explicitCsvUrl?: string,
): Promise<IngestResult> {
  const csvUrl =
    explicitCsvUrl ??
    process.env.MPI_CSV_URL ??
    (await discoverMpiCsvUrl());
  if (!csvUrl) {
    throw new Error(
      'fetchAndIngestMpiDirectory: no CSV URL — set MPI_CSV_URL or check that the FSIS catalog page exposes a "Establishment Number" CSV link.',
    );
  }

  console.log(`[fsis-mpi] fetching ${csvUrl}`);
  const resp = await fetch(csvUrl, {
    headers: {
      'User-Agent': 'procur-fsis-ingest/0.1 (+https://procur.app)',
    },
  });
  if (!resp.ok) {
    throw new Error(
      `fetchAndIngestMpiDirectory: HTTP ${resp.status} for ${csvUrl}`,
    );
  }
  const text = await resp.text();
  const rows = parseCsv(text, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    bom: true,
  }) as MpiCsvRow[];
  console.log(`[fsis-mpi] parsed ${rows.length} CSV rows`);

  let rowsInserted = 0;
  let rowsUpdated = 0;
  let rowsSkipped = 0;
  let errors = 0;

  // Batch upserts to keep round-trip count low. Neon HTTP per-statement
  // call latency is ~100-300ms; 500-row chunks land each batch in
  // a single multi-VALUES INSERT.
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK);
    const mapped: MappedRow[] = [];
    for (const row of slice) {
      const m = mapRow(row);
      if (!m) {
        rowsSkipped += 1;
        continue;
      }
      mapped.push(m);
    }
    if (mapped.length === 0) continue;

    try {
      const result = await db
        .insert(schema.usdaFsisEstablishments)
        .values(mapped)
        .onConflictDoUpdate({
          target: schema.usdaFsisEstablishments.establishmentNumber,
          set: {
            legalName: sql`EXCLUDED.legal_name`,
            dbaName: sql`EXCLUDED.dba_name`,
            street: sql`EXCLUDED.street`,
            city: sql`EXCLUDED.city`,
            state: sql`EXCLUDED.state`,
            zip: sql`EXCLUDED.zip`,
            county: sql`EXCLUDED.county`,
            phone: sql`EXCLUDED.phone`,
            activities: sql`EXCLUDED.activities`,
            species: sql`EXCLUDED.species`,
            grants: sql`EXCLUDED.grants`,
            latitude: sql`COALESCE(EXCLUDED.latitude, ${schema.usdaFsisEstablishments.latitude})`,
            longitude: sql`COALESCE(EXCLUDED.longitude, ${schema.usdaFsisEstablishments.longitude})`,
            rawPayload: sql`EXCLUDED.raw_payload`,
            updatedAt: sql`NOW()`,
          },
        })
        .returning({
          establishmentNumber: schema.usdaFsisEstablishments.establishmentNumber,
        });
      // Drizzle's RETURNING-on-conflict-do-update returns ALL affected
      // rows (inserts + updates indistinguishably). Without a separate
      // pre-check we can't split the count; approximate by treating
      // every batch row as updated and the run-total deficit as
      // inserted on first-time runs.
      rowsUpdated += result.length;
    } catch (err) {
      errors += mapped.length;
      console.warn(
        JSON.stringify({
          level: 'warn',
          service: 'fsis-mpi.ingest',
          msg: 'batch upsert failed — continuing',
          batchStart: i,
          batchSize: mapped.length,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }

  // On first-ever ingest, every "updated" was actually an insert.
  // Hard to distinguish without a SELECT before each batch; for
  // operator-facing reporting we surface the COMBINED count.
  return {
    csvUrl,
    rowsParsed: rows.length,
    rowsInserted,
    rowsUpdated,
    rowsSkipped,
    errors,
  };
}

/**
 * Convenience wrapper: builds a Neon-HTTP drizzle client from
 * process.env.DATABASE_URL then calls fetchAndIngestMpiDirectory.
 *
 * Use this from contexts where you don't already have a db handle
 * (admin routes, Trigger.dev jobs). The CLI wrapper passes its own
 * db so it can share the connection with other operations.
 */
export async function runMpiDirectoryIngest(
  explicitCsvUrl?: string,
): Promise<IngestResult> {
  if (!process.env.DATABASE_URL) {
    throw new Error('runMpiDirectoryIngest: DATABASE_URL is required.');
  }
  const db = drizzle(neon(process.env.DATABASE_URL), { schema });
  return fetchAndIngestMpiDirectory(db, explicitCsvUrl);
}
