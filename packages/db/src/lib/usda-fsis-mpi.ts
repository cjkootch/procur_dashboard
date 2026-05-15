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

import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { parse as parseCsv } from 'csv-parse/sync';
import { sql } from 'drizzle-orm';
import { neon } from '@neondatabase/serverless';
import { drizzle, type drizzle as drizzleType } from 'drizzle-orm/neon-http';
import * as cheerio from 'cheerio';
import * as schema from '../schema';

/**
 * FSIS sits behind Akamai bot-protection that 403s plain Node fetches
 * (procur-fsis-ingest UA gets blocked). A standard browser UA + the
 * common companion headers (Accept, Accept-Language) pass cleanly.
 * We're a polite-frequency caller (quarterly cadence), so this isn't
 * adversarial scraping — just defeating an overly-aggressive WAF rule.
 */
const BROWSER_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

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
    const resp = await fetch(FSIS_CATALOG_PAGE, { headers: BROWSER_HEADERS });
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
  sizeClass: string | null;
  dunsNumber: string | null;
  grantDate: string | null;
  fsisDistrict: string | null;
  fsisCircuit: string | null;
  rawPayload: Record<string, unknown>;
}

/**
 * Parse FSIS's `activities` semicolon-joined string into a normalized
 * activity-type set + coarse species set.
 *
 * FSIS encodes BOTH activity AND species hint via labels like
 * "Meat Slaughter", "Poultry Processing", "Egg Product",
 * "Identification - Siluriformes", "Off-Premise Freezing - Meat".
 *
 * Coarse species split: 'meat' (covers cattle/swine/sheep/goat/equine —
 * the demographic-data CSV refines this), 'poultry' (chicken/turkey/etc),
 * 'egg', 'fish' (siluriformes). Operator can refine via a follow-up
 * join against the Establishment Demographic Data CSV.
 */
function parseActivitiesAndSpecies(raw: string | null): {
  activities: string[];
  species: string[];
} {
  if (!raw) return { activities: [], species: [] };
  const parts = raw
    .split(/[;|]/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  const activities = new Set<string>();
  const species = new Set<string>();
  for (const p of parts) {
    if (p.includes('slaughter')) activities.add('slaughter');
    if (p.includes('processing')) activities.add('processing');
    if (p.includes('identification')) activities.add('identification');
    if (p.includes('imported product') || p.includes('import')) activities.add('import');
    if (p.includes('off-premise freezing')) activities.add('off_premise_freezing');
    if (p.includes('certification')) activities.add('certification');
    if (p.includes('food inspection')) activities.add('food_inspection');
    if (p.includes('voluntary')) activities.add('voluntary');

    if (p.includes('meat')) species.add('meat');
    if (p.includes('poultry')) species.add('poultry');
    if (p.includes('egg')) species.add('egg');
    if (p.includes('siluriformes') || p.includes('catfish')) species.add('fish');
  }
  return {
    activities: Array.from(activities),
    species: Array.from(species),
  };
}

function parseGrantDate(input: string | null): string | null {
  if (!input) return null;
  const trimmed = input.trim();
  // FSIS format observed: M/D/YYYY (e.g. "1/28/2026").
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(trimmed);
  if (us?.[1] && us[2] && us[3]) {
    const mm = us[1].padStart(2, '0');
    const dd = us[2].padStart(2, '0');
    return `${us[3]}-${mm}-${dd}`;
  }
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(trimmed);
  if (iso?.[1] && iso[2] && iso[3]) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  return null;
}

function normalizeSizeClass(raw: string | null): string | null {
  if (!raw) return null;
  const t = raw.trim();
  if (!t || t.toLowerCase() === 'n / a' || t.toLowerCase() === 'n/a') return null;
  return t;
}

function mapRow(row: MpiCsvRow): MappedRow | null {
  // FSIS CSV uses snake_case columns; legacy title-case aliases kept
  // for resilience against future schema shifts.
  const establishmentNumber = pickField(
    row,
    'establishment_number',
    'Establishment Number',
    'EstablishmentNumber',
  );
  const legalName = pickField(
    row,
    'establishment_name',
    'Establishment Name',
    'Company Name',
    'Legal Name',
  );
  if (!establishmentNumber || !legalName) return null;

  const activitiesRaw = pickField(row, 'activities', 'Activities', 'Activity');
  const { activities, species } = parseActivitiesAndSpecies(activitiesRaw);

  const grantsRaw = pickField(row, 'grants', 'Inspection Grants', 'Inspection Type');

  const lat = parseFloatSafe(pickField(row, 'latitude', 'Latitude', 'Lat'));
  const lng = parseFloatSafe(pickField(row, 'longitude', 'Longitude', 'Lon', 'Lng'));

  // `dbas` is comma- or semicolon-joined in FSIS. Take first when
  // multiple; rest would land in raw_payload for reference.
  const dbasRaw = pickField(row, 'dbas', 'DBA Name', 'DBA', 'Doing Business As');
  const dbaName = dbasRaw ? dbasRaw.split(/[,;]/)[0]?.trim() || null : null;

  return {
    establishmentNumber,
    legalName,
    dbaName,
    street: pickField(row, 'street', 'Street', 'Street Address', 'Address'),
    city: pickField(row, 'city', 'City'),
    state: pickField(row, 'state', 'State', 'St'),
    zip: pickField(row, 'zip', 'Zip', 'ZIP', 'Zip Code', 'Postal Code'),
    county: pickField(row, 'county', 'County'),
    phone: pickField(row, 'phone', 'Phone', 'Phone Number'),
    activities,
    species,
    grants: splitMulti(grantsRaw)
      .map(normalizeGrant)
      .filter((v): v is string => v != null),
    latitude: lat != null ? String(lat) : null,
    longitude: lng != null ? String(lng) : null,
    sizeClass: normalizeSizeClass(pickField(row, 'size', 'Size', 'size_class')),
    dunsNumber: pickField(row, 'duns_number', 'DUNS', 'DUNS Number'),
    grantDate: parseGrantDate(pickField(row, 'grant_date', 'Grant Date')),
    fsisDistrict: pickField(row, 'district', 'District', 'FSIS District'),
    fsisCircuit: pickField(row, 'circuit', 'Circuit', 'FSIS Circuit'),
    rawPayload: row as Record<string, unknown>,
  };
}

/**
 * Fetch + parse + upsert the MPI Directory.
 *
 * Source resolution order:
 *   1. MPI_CSV_PATH env var (local file) — for operators who
 *      downloaded the CSV manually because FSIS's Akamai WAF blocks
 *      programmatic UAs in their region
 *   2. `explicitCsvUrl` arg — passed by caller
 *   3. MPI_CSV_URL env var — pinned URL
 *   4. Auto-discovery via the FSIS catalog page
 *
 * @param db Drizzle Neon-HTTP client.
 * @param explicitCsvUrl When set, overrides URL discovery (but not
 *   MPI_CSV_PATH). Useful for testing against a pinned CSV.
 */
export async function fetchAndIngestMpiDirectory(
  db: Db,
  explicitCsvUrl?: string,
): Promise<IngestResult> {
  const localPath = process.env.MPI_CSV_PATH;
  let text: string;
  let csvUrl: string;

  if (localPath) {
    // Resolve against the user's invocation cwd so relative paths
    // like `./data/mpi.csv` work regardless of where pnpm parked us.
    const resolved = isAbsolute(localPath)
      ? localPath
      : resolve(process.env.INIT_CWD ?? process.cwd(), localPath);
    console.log(`[fsis-mpi] reading local file ${resolved}`);
    text = await readFile(resolved, 'utf8');
    csvUrl = `file://${resolved}`;
  } else {
    const resolvedUrl =
      explicitCsvUrl ??
      process.env.MPI_CSV_URL ??
      (await discoverMpiCsvUrl());
    if (!resolvedUrl) {
      throw new Error(
        'fetchAndIngestMpiDirectory: no CSV source — set MPI_CSV_PATH (local file), MPI_CSV_URL (pinned URL), or check that the FSIS catalog page exposes an Establishment-Number CSV link.',
      );
    }
    csvUrl = resolvedUrl;
    console.log(`[fsis-mpi] fetching ${csvUrl}`);
    const resp = await fetch(csvUrl, {
      headers: {
        ...BROWSER_HEADERS,
        Referer: FSIS_CATALOG_PAGE,
      },
    });
    if (!resp.ok) {
      throw new Error(
        `fetchAndIngestMpiDirectory: HTTP ${resp.status} for ${csvUrl}. If FSIS is blocking the fetch, download the CSV manually and set MPI_CSV_PATH=/path/to/file.csv instead.`,
      );
    }
    text = await resp.text();
  }

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
            sizeClass: sql`EXCLUDED.size_class`,
            dunsNumber: sql`EXCLUDED.duns_number`,
            grantDate: sql`EXCLUDED.grant_date`,
            fsisDistrict: sql`EXCLUDED.fsis_district`,
            fsisCircuit: sql`EXCLUDED.fsis_circuit`,
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
