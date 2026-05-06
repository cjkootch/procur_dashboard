/**
 * VIIRS Nighttime Lights ingest — facility-level activity proxy
 * extraction from monthly DNB composites.
 *
 * Per buyer-intelligence-v2-free-sources-brief.md §4.4. VIIRS DNB
 * (Day-Night Band) monthly composites from the Earth Observation
 * Group at Colorado School of Mines provide ~500m-resolution
 * nighttime light intensity globally since 2012, free, GeoTIFF.
 *
 * What it tells us: industrial facilities with active operations
 * show consistent nighttime light signatures. Refineries, mines,
 * port terminals, large industrial estates all radiate measurable
 * light. Time-series at facility coords detects ramp-up / ramp-
 * down / curtailment events months before they show up in news or
 * customs data.
 *
 * Pipeline:
 *   1. Read VIIRS GeoTIFF (path-driven first cut; URL streaming
 *      supported via --url for COG-style range reads)
 *   2. For every known_entities row with lat/long, sample the pixel
 *      value at those coordinates
 *   3. Optional small spatial-mean window (--window=N) averages an
 *      N×N pixel window around the point — defends against single-
 *      pixel noise on facility-scale signals
 *   4. Upsert into entity_activity_observations
 *      (entity_slug, source='viirs_ntl', observation_date)
 *
 * Yearly aggregation into fuel_consumption_signals
 * (signal_kind='activity_signal') is a follow-up — needs a tuned
 * NTL→bbl heuristic by facility type (refinery vs mine vs port has
 * different baseline luminosity). Brief §4.4 confidence:
 *   - 0.50 for absolute consumption estimates
 *   - 0.75 for relative changes over time (this is where the value lies)
 *
 * Run from repo root:
 *   pnpm --filter @procur/db ingest-viirs-ntl <path-to-viirs.tif> --date=2024-03-01
 *   pnpm --filter @procur/db ingest-viirs-ntl <path> --date=2024-03-01 --window=3
 *   pnpm --filter @procur/db ingest-viirs-ntl <url> --url --date=2024-03-01
 *   pnpm --filter @procur/db ingest-viirs-ntl <path> --date=2024-03-01 --dry-run
 */
import 'dotenv/config';
import { config as loadEnv } from 'dotenv';
import { readFile } from 'node:fs/promises';
import { resolve, isAbsolute } from 'node:path';
import { sql } from 'drizzle-orm';
import { fromArrayBuffer, fromUrl } from 'geotiff';
import { db } from './client';

loadEnv({ path: '../../.env.local' });
loadEnv({ path: '../../.env' });

const SOURCE = 'viirs_ntl';
const UNIT = 'nW/cm2/sr';

type Args = {
  pathOrUrl: string;
  isUrl: boolean;
  observationDate: string; // YYYY-MM-DD
  windowSize: number; // odd integer; 1 = single-pixel, 3 = 3×3 mean, etc.
  dryRun: boolean;
  countryFilter: string | null;
};

function parseArgs(): Args {
  const args = process.argv.slice(2);
  const positional = args.find((a) => !a.startsWith('--'));
  const isUrl = args.includes('--url');
  const dateArg = args.find((a) => a.startsWith('--date='));
  const windowArg = args.find((a) => a.startsWith('--window='));
  const countryArg = args.find((a) => a.startsWith('--country='));
  const dryRun = args.includes('--dry-run');

  if (!positional) {
    console.error(
      'Usage: pnpm --filter @procur/db ingest-viirs-ntl <path|url> --date=YYYY-MM-DD\n' +
        '  --url             Treat positional as URL (HTTP range reads via Cloud-Optimized GeoTIFF)\n' +
        '  --date=YYYY-MM-DD Observation date (typically month-start)\n' +
        '  --window=N        Spatial mean over N×N pixel window (odd; default 1 = single pixel)\n' +
        '  --country=CC      Restrict to known_entities in given ISO-2 country\n' +
        '  --dry-run         Print samples; do not write\n' +
        '\n' +
        'Source: https://eogdata.mines.edu/products/vnl/ — monthly composites since 2012.',
    );
    process.exit(1);
  }
  if (!dateArg) {
    console.error('--date=YYYY-MM-DD is required');
    process.exit(1);
  }
  const observationDate = dateArg.split('=')[1] ?? '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(observationDate)) {
    console.error(`--date must be YYYY-MM-DD, got "${observationDate}"`);
    process.exit(1);
  }
  const windowSize = windowArg
    ? Math.max(1, Number.parseInt(windowArg.split('=')[1] ?? '1', 10))
    : 1;
  if (windowSize % 2 !== 1) {
    console.error(`--window must be odd, got ${windowSize}`);
    process.exit(1);
  }
  const countryFilter = countryArg
    ? (countryArg.split('=')[1] ?? '').toUpperCase() || null
    : null;
  return {
    pathOrUrl: positional,
    isUrl,
    observationDate,
    windowSize,
    dryRun,
    countryFilter,
  };
}

function resolveUserPath(p: string): string {
  if (isAbsolute(p)) return p;
  const baseDir = process.env.INIT_CWD ?? process.cwd();
  return resolve(baseDir, p);
}

type Geocoded = {
  slug: string;
  name: string;
  country: string;
  latitude: number;
  longitude: number;
};

async function loadGeocodedEntities(countryFilter: string | null): Promise<Geocoded[]> {
  const rows = (await (countryFilter
    ? db.execute(sql`
        SELECT slug, name, country, latitude::float8 AS latitude, longitude::float8 AS longitude
          FROM known_entities
         WHERE latitude IS NOT NULL
           AND longitude IS NOT NULL
           AND country = ${countryFilter}
      `)
    : db.execute(sql`
        SELECT slug, name, country, latitude::float8 AS latitude, longitude::float8 AS longitude
          FROM known_entities
         WHERE latitude IS NOT NULL
           AND longitude IS NOT NULL
      `))).rows as unknown as Array<{
    slug: string;
    name: string;
    country: string;
    latitude: number;
    longitude: number;
  }>;
  return rows.map((r) => ({
    slug: r.slug,
    name: r.name,
    country: r.country,
    latitude: Number(r.latitude),
    longitude: Number(r.longitude),
  }));
}

type Geo = {
  // Pixel size in degrees (positive)
  pxLon: number;
  pxLat: number;
  // Top-left lon / lat
  originLon: number;
  originLat: number;
  width: number;
  height: number;
};

/**
 * Convert lat/long → pixel (x, y) using GeoTIFF model tie-points +
 * pixel scale. Assumes the standard EPSG:4326 georeferenced shape
 * VIIRS DNB composites use (top-left origin, pixel scale in degrees).
 */
function latLonToPixel(geo: Geo, lat: number, lon: number): { x: number; y: number } | null {
  // Negative lat-step because GeoTIFF row 0 is the northernmost row.
  const x = Math.round((lon - geo.originLon) / geo.pxLon);
  const y = Math.round((geo.originLat - lat) / geo.pxLat);
  if (x < 0 || x >= geo.width || y < 0 || y >= geo.height) return null;
  return { x, y };
}

async function main(): Promise<void> {
  const args = parseArgs();
  console.log(
    `ingest-viirs-ntl — date=${args.observationDate}, window=${args.windowSize}, country=${args.countryFilter ?? 'ALL'}, mode=${args.isUrl ? 'url' : 'file'}`,
  );

  const tiff = args.isUrl
    ? await fromUrl(args.pathOrUrl)
    : await (async () => {
        const buf = await readFile(resolveUserPath(args.pathOrUrl));
        // Convert Node Buffer to ArrayBuffer for geotiff.
        const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
        return fromArrayBuffer(ab);
      })();

  const image = await tiff.getImage();
  const width = image.getWidth();
  const height = image.getHeight();
  const bbox = image.getBoundingBox(); // [minX, minY, maxX, maxY] = [west, south, east, north]
  const origin = image.getOrigin();
  const res = image.getResolution(); // res[1] (y-step) is typically negative
  const origin0 = origin[0] ?? bbox[0];
  const origin1 = origin[1] ?? bbox[3];
  const resX = res[0] ?? 0;
  const resY = res[1] ?? 0;
  if (origin0 == null || origin1 == null || !resX || !resY) {
    throw new Error('GeoTIFF missing origin/resolution metadata — non-georeferenced raster.');
  }

  const geo: Geo = {
    pxLon: Math.abs(resX),
    pxLat: Math.abs(resY),
    originLon: origin0,
    originLat: origin1,
    width,
    height,
  };

  console.log(
    `  raster: ${width}×${height}, bbox=[${bbox.map((b) => b.toFixed(2)).join(', ')}], res=${geo.pxLon.toFixed(6)}°/px`,
  );

  const entities = await loadGeocodedEntities(args.countryFilter);
  console.log(`  ${entities.length} geocoded entities to sample`);

  const half = (args.windowSize - 1) / 2;

  let sampled = 0;
  let outOfBounds = 0;
  let inserted = 0;
  const samples: Array<{ slug: string; name: string; value: number }> = [];

  for (const e of entities) {
    const pixel = latLonToPixel(geo, e.latitude, e.longitude);
    if (!pixel) {
      outOfBounds += 1;
      continue;
    }

    const x0 = Math.max(0, pixel.x - half);
    const y0 = Math.max(0, pixel.y - half);
    const x1 = Math.min(width, pixel.x + half + 1);
    const y1 = Math.min(height, pixel.y + half + 1);
    const window = (await image.readRasters({
      window: [x0, y0, x1, y1],
      interleave: true,
    })) as unknown as Float32Array | Uint16Array | Int16Array;

    if (window.length === 0) {
      outOfBounds += 1;
      continue;
    }

    // Mean across the window cells, ignoring negative / fill values
    // (VIIRS uses -1 / -1.5 / negative-large for fill in many products).
    let sum = 0;
    let n = 0;
    for (let i = 0; i < window.length; i += 1) {
      const v = Number(window[i]);
      if (Number.isFinite(v) && v >= 0) {
        sum += v;
        n += 1;
      }
    }
    if (n === 0) {
      outOfBounds += 1;
      continue;
    }
    const value = sum / n;
    sampled += 1;
    if (samples.length < 15) {
      samples.push({ slug: e.slug, name: e.name, value });
    }

    if (args.dryRun) continue;

    await db.execute(sql`
      INSERT INTO entity_activity_observations (
        entity_slug, source, observation_date, value, unit, notes, raw_data
      ) VALUES (
        ${e.slug},
        ${SOURCE},
        ${args.observationDate},
        ${value.toFixed(6)},
        ${UNIT},
        ${`VIIRS DNB ${args.observationDate} sampled at (${e.latitude.toFixed(4)}, ${e.longitude.toFixed(4)}) over ${args.windowSize}×${args.windowSize} window`},
        ${JSON.stringify({
          coords: { lat: e.latitude, lon: e.longitude },
          pixel,
          windowSize: args.windowSize,
          windowCells: n,
        })}::jsonb
      )
      ON CONFLICT (entity_slug, source, observation_date)
      DO UPDATE SET
        value = EXCLUDED.value,
        notes = EXCLUDED.notes,
        raw_data = EXCLUDED.raw_data;
    `);
    inserted += 1;
  }

  console.log(
    `\n  ${sampled} sampled, ${outOfBounds} outside raster / no valid cells`,
  );
  if (samples.length > 0) {
    console.log('  preview (first 15):');
    for (const s of samples) {
      console.log(`    ${s.slug.padEnd(50)} ${s.value.toFixed(2).padStart(8)} ${UNIT}`);
    }
  }

  if (args.dryRun) {
    console.log('\n(dry run — no rows written.)');
  } else {
    console.log(`\nUpserted ${inserted} rows into entity_activity_observations.`);
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
