/**
 * Global Energy Monitor — Global Oil Refinery Tracker (GORT) ingest.
 *
 * Source: https://globalenergymonitor.org/trackers/
 *   GEM occasionally restructures their projects pages. As of this
 *   commit the GORT lives under the "Trackers" hub. If the link 404s,
 *   navigate from globalenergymonitor.org → Trackers → search for
 *   "oil refinery" or "oil infrastructure". The data is now sometimes
 *   bundled into the "Global Oil Infrastructure Tracker" (GOIT).
 *
 * License: CC-BY-4.0 (free with attribution)
 * Coverage: ~700 refineries globally with capacity-by-unit detail,
 *   owner, status, startup year, latitude/longitude.
 *
 * GEM gates the download behind a request form (not technical — just
 * collects who's using the data; usually approved within hours).
 * Once you have the file, run this script with the path:
 *
 *   pnpm --filter @procur/db ingest-gem-refineries ./gort.csv
 *
 * Or set GEM_REFINERY_CSV_PATH env var.
 *
 * Free alternative if you can't get GEM access:
 *   pnpm --filter @procur/db ingest-osm-refineries
 *   (queries OpenStreetMap Overpass — no auth, ~300-600 refineries
 *   with name + lat/lng, fewer with operator/capacity)
 *
 * Expected columns (case-insensitive, GEM may rename across releases):
 *   - "Plant Name" / "Refinery Name" / "Project Name"
 *   - "Country"
 *   - "Operator" / "Operator Name"
 *   - "Owner" / "Owner Name"
 *   - "Capacity (bbl/d)" / "Atmospheric Capacity (bbl/d)"
 *   - "Status"
 *   - "Start Year" / "Year Built"
 *   - "Latitude"
 *   - "Longitude"
 *
 * Cross-source de-dup: rows are merged into existing known_entities
 * via fuzzy name+country match (similarity ≥ 0.55). Curated rows
 * never lose their analyst-edited fields; GEM data fills gaps.
 */

import 'dotenv/config';
import { config as loadEnv } from 'dotenv';
import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import * as schema from './schema';
import { findOrUpsertEntity } from './lib/find-or-upsert-entity';
import { readTabular, pickCol, parseNumberSafe } from './lib/read-tabular';

loadEnv({ path: '../../.env.local' });
loadEnv({ path: '../../.env' });

/** ISO-3 → ISO-2 — only the ones that come up in the GORT export.
 *  Extend as needed; unmapped countries fall back to first-2-letter
 *  truncation which is fine for sorting but not for joins. */
const COUNTRY_NAME_TO_ISO2: Record<string, string> = {
  'united states': 'US', 'united states of america': 'US',
  'china': 'CN', 'india': 'IN', 'russia': 'RU', 'japan': 'JP',
  'south korea': 'KR', 'korea, republic of': 'KR',
  'saudi arabia': 'SA', 'iran': 'IR', 'iraq': 'IQ', 'kuwait': 'KW',
  'qatar': 'QA', 'united arab emirates': 'AE', 'oman': 'OM',
  'turkey': 'TR', 'turkiye': 'TR',
  'germany': 'DE', 'france': 'FR', 'italy': 'IT', 'spain': 'ES',
  'united kingdom': 'GB', 'netherlands': 'NL', 'belgium': 'BE',
  'greece': 'GR', 'portugal': 'PT', 'sweden': 'SE', 'finland': 'FI',
  'norway': 'NO', 'austria': 'AT', 'hungary': 'HU', 'czechia': 'CZ',
  'czech republic': 'CZ', 'slovakia': 'SK', 'poland': 'PL',
  'romania': 'RO', 'bulgaria': 'BG', 'croatia': 'HR', 'serbia': 'RS',
  'ukraine': 'UA', 'belarus': 'BY',
  'canada': 'CA', 'mexico': 'MX', 'brazil': 'BR', 'argentina': 'AR',
  'venezuela': 'VE', 'colombia': 'CO', 'chile': 'CL', 'peru': 'PE',
  'ecuador': 'EC', 'bolivia': 'BO', 'cuba': 'CU',
  'trinidad and tobago': 'TT', 'jamaica': 'JM', 'dominican republic': 'DO',
  'south africa': 'ZA', 'nigeria': 'NG', 'egypt': 'EG', 'algeria': 'DZ',
  'libya': 'LY', 'morocco': 'MA', 'tunisia': 'TN', 'angola': 'AO',
  'kenya': 'KE', 'ghana': 'GH', 'tanzania': 'TZ', 'sudan': 'SD',
  'indonesia': 'ID', 'malaysia': 'MY', 'singapore': 'SG',
  'thailand': 'TH', 'vietnam': 'VN', 'philippines': 'PH',
  'pakistan': 'PK', 'bangladesh': 'BD', 'sri lanka': 'LK', 'myanmar': 'MM',
  'australia': 'AU', 'new zealand': 'NZ', 'kazakhstan': 'KZ',
  'azerbaijan': 'AZ', 'turkmenistan': 'TM', 'uzbekistan': 'UZ',
};

function nameToIso2(name: string): string {
  const k = name.trim().toLowerCase();
  return COUNTRY_NAME_TO_ISO2[k] ?? name.slice(0, 2).toUpperCase();
}

function slugify(name: string, country: string): string {
  const base = name
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `gem-${country.toLowerCase() || 'xx'}-${base}`;
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set');

  const path = process.argv[2] ?? process.env.GEM_REFINERY_CSV_PATH;
  if (!path) {
    console.error(
      'Usage: pnpm --filter @procur/db ingest-gem-refineries <path-to-refineries.xlsx-or-csv>\n' +
        'Or set GEM_REFINERY_CSV_PATH env var.\n' +
        'Download from https://globalenergymonitor.org/trackers/ — look for an "Oil Refineries"\n' +
        'or "GORT" file. Pipelines and extraction are separate downloads.',
    );
    process.exit(1);
  }

  console.log(`Reading GEM refineries from ${path}...`);
  const records = await readTabular(path);
  console.log(`  ${records.length} rows`);

  const client = neon(url);
  const db = drizzle(client, { schema, casing: 'snake_case' });

  let inserted = 0;
  let merged = 0;
  let skipped = 0;

  for (const row of records) {
    const name = pickCol(row, 'Plant Name', 'Refinery Name', 'Project Name', 'Name');
    const countryName = pickCol(row, 'Country');
    if (!name || !countryName) {
      skipped += 1;
      continue;
    }
    const country = nameToIso2(countryName);
    const operator = pickCol(row, 'Operator', 'Operator Name');
    const owner = pickCol(row, 'Owner', 'Owner Name');
    const capacityBpd = parseNumberSafe(
      pickCol(row, 'Capacity (bbl/d)', 'Atmospheric Capacity (bbl/d)', 'CDU Capacity (bbl/d)'),
    );
    const status = pickCol(row, 'Status', 'Operating Status');
    const startYear = parseNumberSafe(pickCol(row, 'Start Year', 'Year Built', 'Year Started'));
    const lat = parseNumberSafe(pickCol(row, 'Latitude', 'Lat'));
    const lng = parseNumberSafe(pickCol(row, 'Longitude', 'Lng', 'Lon'));
    const gemId = pickCol(row, 'Plant ID', 'GORT ID', 'GEM ID', 'ID');

    const noteParts: string[] = [];
    if (operator) noteParts.push(`Operator: ${operator}`);
    if (owner && owner !== operator) noteParts.push(`Owner: ${owner}`);
    if (capacityBpd) noteParts.push(`Capacity: ${capacityBpd.toLocaleString()} bpd`);
    if (status) noteParts.push(`Status: ${status}`);
    if (startYear) noteParts.push(`Started: ${startYear}`);
    noteParts.push('Source: GEM Global Oil Refinery Tracker');

    const tags: string[] = ['refinery'];
    if (status) tags.push(`status:${status.toLowerCase().replace(/\s+/g, '-')}`);
    if (capacityBpd != null) {
      if (capacityBpd >= 400_000) tags.push('size:mega');
      else if (capacityBpd >= 200_000) tags.push('size:large');
      else if (capacityBpd >= 100_000) tags.push('size:mid');
      else tags.push('size:small');
    }
    const med = ['IT', 'ES', 'FR', 'GR', 'TR', 'CY', 'MT', 'HR', 'SI', 'AL'];
    if (med.includes(country)) tags.push('region:mediterranean');
    const asia = ['IN', 'ID', 'PK', 'BD', 'LK', 'TH', 'VN', 'PH', 'MY'];
    if (asia.includes(country)) tags.push('region:asia-state');

    const result = await findOrUpsertEntity(db, {
      slug: slugify(name, country),
      source: 'gem',
      name,
      country,
      role: 'refiner',
      categories: ['crude-oil', 'diesel', 'gasoline', 'jet-fuel'],
      notes: noteParts.join(' · '),
      aliases: [name],
      tags,
      latitude: lat,
      longitude: lng,
      metadata: {
        gem_id: gemId,
        operator,
        owner,
        capacity_bpd: capacityBpd,
        status,
        inception_year: startYear,
      },
    });
    if (result.outcome === 'inserted') inserted += 1;
    else merged += 1;
  }

  console.log(
    `Done. inserted=${inserted}, merged=${merged} (enriched existing curated/Wikidata rows), skipped=${skipped} (missing name or country).`,
  );
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
