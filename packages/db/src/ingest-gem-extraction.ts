/**
 * Global Energy Monitor — Global Oil & Gas Extraction Tracker (GOGET) ingest.
 *
 * Source: https://globalenergymonitor.org/projects/global-oil-gas-extraction-tracker/
 *   (or wherever GEM has it now under their Trackers hub)
 * License: CC-BY-4.0
 * Coverage: ~3,000 oil + gas extraction projects globally with operator,
 *   parent companies, status, capacity, lat/lng.
 *
 * Distinct from GORT (refineries — downstream): GOGET tracks UPSTREAM
 * production. For VTC's sell-side workflow this is what reveals who
 * extracts the crude (Sharara field, Bouri, Mellitah → operator NOC
 * Libya + IOC partners like Repsol/Eni).
 *
 * Entity role: 'producer'.
 *
 * Default filters:
 *   - Resource includes 'oil' or 'crude' (drop pure-gas projects).
 *     Override with --include-gas to keep gas-only fields.
 *   - Status in {operating, under construction, in development,
 *     discovered}. Override with --include-shelved to keep
 *     shelved/cancelled/decommissioned.
 *
 * Run: pnpm --filter @procur/db ingest-gem-extraction <path-to-xlsx-or-csv>
 *      pnpm --filter @procur/db ingest-gem-extraction <path> --include-gas
 *      pnpm --filter @procur/db ingest-gem-extraction <path> --include-shelved
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

/** ISO-3 / country-name → ISO-2. Same shape as the GEM refinery + OSM
 *  ingests; consolidate into a shared lib if a fourth caller appears. */
const COUNTRY_NAME_TO_ISO2: Record<string, string> = {
  'united states': 'US', 'united states of america': 'US', 'usa': 'US',
  'china': 'CN', 'india': 'IN', 'russia': 'RU', 'russian federation': 'RU',
  'japan': 'JP', 'south korea': 'KR', 'korea, republic of': 'KR',
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
  'south sudan': 'SS', 'gabon': 'GA', 'cameroon': 'CM',
  'republic of the congo': 'CG', 'congo': 'CG',
  "côte d'ivoire": 'CI', 'cote d ivoire': 'CI', 'ivory coast': 'CI',
  'indonesia': 'ID', 'malaysia': 'MY', 'singapore': 'SG',
  'thailand': 'TH', 'vietnam': 'VN', 'philippines': 'PH',
  'pakistan': 'PK', 'bangladesh': 'BD', 'sri lanka': 'LK', 'myanmar': 'MM',
  'australia': 'AU', 'new zealand': 'NZ', 'kazakhstan': 'KZ',
  'azerbaijan': 'AZ', 'turkmenistan': 'TM', 'uzbekistan': 'UZ',
  'israel': 'IL', 'jordan': 'JO', 'lebanon': 'LB', 'syria': 'SY',
  'yemen': 'YE',
};

function nameToIso2(name: string): string | null {
  const k = name.trim().toLowerCase();
  return COUNTRY_NAME_TO_ISO2[k] ?? null;
}

function slugify(name: string, country: string): string {
  const base = name
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `gem-extract-${country.toLowerCase() || 'xx'}-${base}`;
}

const ACTIVE_STATUSES = new Set([
  'operating',
  'under construction',
  'in development',
  'discovered',
  'pre-construction',
  'announced',
  'producing',
]);

const SHELVED_STATUSES = new Set([
  'shelved',
  'cancelled',
  'mothballed',
  'decommissioned',
  'depleted',
  'abandoned',
  'idle',
]);

/** Resource is oil-relevant if it contains any of these tokens. */
function isOilResource(resource: string | null): boolean {
  if (!resource) return false;
  const r = resource.toLowerCase();
  return /\b(oil|crude|petroleum|liquids|condensate)\b/.test(r);
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set');

  const args = process.argv.slice(2);
  const path = args.find((a) => !a.startsWith('--')) ?? process.env.GEM_EXTRACTION_PATH;
  const includeGas = args.includes('--include-gas');
  const includeShelved = args.includes('--include-shelved');

  if (!path) {
    console.error(
      'Usage: pnpm --filter @procur/db ingest-gem-extraction <path-to-goget-xlsx-or-csv>\n' +
        '  --include-gas      keep gas-only fields (default: oil/oil+gas only)\n' +
        '  --include-shelved  keep shelved/cancelled/decommissioned fields\n' +
        'Or set GEM_EXTRACTION_PATH env var.\n' +
        'Download GOGET from https://globalenergymonitor.org/trackers/',
    );
    process.exit(1);
  }

  console.log(`Reading GOGET data from ${path}...`);
  console.log(`  filters: oil-only=${!includeGas}, active-only=${!includeShelved}`);
  const rows = await readTabular(path);
  console.log(`  ${rows.length} raw rows`);

  const client = neon(url);
  const db = drizzle(client, { schema, casing: 'snake_case' });

  let inserted = 0;
  let merged = 0;
  let skippedNoCountry = 0;
  let skippedNotOil = 0;
  let skippedShelved = 0;
  let skippedNoName = 0;
  const unmappedCountries = new Map<string, number>();

  for (const row of rows) {
    const name = pickCol(
      row,
      'Project Name',
      'Unit Name',
      'Field Name',
      'Asset Name',
      'Site Name',
      'Project',
      'Name',
    );
    if (!name) {
      skippedNoName += 1;
      continue;
    }

    const countryName = pickCol(row, 'Country/Area', 'Country', 'Location Country');
    const country = countryName ? nameToIso2(countryName) : null;
    if (!country) {
      skippedNoCountry += 1;
      if (countryName) {
        unmappedCountries.set(countryName, (unmappedCountries.get(countryName) ?? 0) + 1);
      }
      continue;
    }

    const status = pickCol(row, 'Status', 'Project Status', 'Operating Status') ?? '';
    const statusLower = status.toLowerCase();
    if (!includeShelved && SHELVED_STATUSES.has(statusLower)) {
      skippedShelved += 1;
      continue;
    }

    const resource =
      pickCol(row, 'Fuel Description', 'Fuel', 'Resource', 'Type', 'Resource Type', 'Asset Type') ??
      '';
    if (!includeGas && !isOilResource(resource)) {
      skippedNotOil += 1;
      continue;
    }

    const operator = pickCol(row, 'Operator', 'Operator Name');
    const parents = pickCol(
      row,
      'Parent',
      'Parent Companies',
      'Owner',
      'Owners',
      'Parent Company',
    );
    const capacityOilBpd = parseNumberSafe(
      pickCol(
        row,
        'Production - Oil (bbl/d)',
        'Capacity (bbl/d)',
        'Production Capacity (bbl/d)',
        'Oil Capacity (bbl/d)',
      ),
    );
    const startYear = parseNumberSafe(
      pickCol(row, 'Production Start Year', 'Start Year', 'Year', 'Discovery Year'),
    );
    const lat = parseNumberSafe(pickCol(row, 'Latitude', 'Lat'));
    const lng = parseNumberSafe(pickCol(row, 'Longitude', 'Lng', 'Lon'));
    const gemId = pickCol(row, 'GEM Wiki Page ID', 'Project ID', 'Unit ID', 'GEM ID', 'ID');

    const noteParts: string[] = [];
    if (operator) noteParts.push(`Operator: ${operator}`);
    if (parents && parents !== operator) noteParts.push(`Parent: ${parents}`);
    if (resource) noteParts.push(`Resource: ${resource}`);
    if (capacityOilBpd) noteParts.push(`Production: ${Math.round(capacityOilBpd).toLocaleString()} bbl/d oil`);
    if (status) noteParts.push(`Status: ${status}`);
    if (startYear) noteParts.push(`Started: ${startYear}`);
    noteParts.push('Source: GEM Global Oil & Gas Extraction Tracker');

    const tagList: string[] = ['producer', 'upstream'];
    if (statusLower) tagList.push(`status:${statusLower.replace(/\s+/g, '-')}`);
    if (capacityOilBpd != null) {
      if (capacityOilBpd >= 200_000) tagList.push('size:mega');
      else if (capacityOilBpd >= 50_000) tagList.push('size:large');
      else if (capacityOilBpd >= 10_000) tagList.push('size:mid');
      else tagList.push('size:small');
    }
    // Helpful regional tag for the Libyan deal — surface neighbours
    const ly = ['LY', 'DZ', 'TN', 'EG'];
    if (ly.includes(country)) tagList.push('region:north-africa');
    const opec = ['SA', 'IR', 'IQ', 'KW', 'AE', 'QA', 'VE', 'NG', 'AO', 'LY', 'DZ'];
    if (opec.includes(country)) tagList.push('opec');

    const result = await findOrUpsertEntity(db, {
      slug: slugify(name, country),
      source: 'gem',
      name,
      country,
      role: 'producer',
      categories: ['crude-oil'],
      notes: noteParts.join(' · '),
      aliases: [name],
      tags: tagList,
      latitude: lat,
      longitude: lng,
      metadata: {
        gem_id: gemId,
        operator,
        parent_companies: parents,
        status: statusLower || null,
        resource_type: resource || null,
        capacity_oil_bpd: capacityOilBpd,
        production_start_year: startYear,
      },
    });
    if (result.outcome === 'inserted') inserted += 1;
    else merged += 1;
  }

  console.log(
    `Done. inserted=${inserted}, merged=${merged} (enriched existing rows), ` +
      `skipped=${skippedNotOil} (gas-only), ${skippedShelved} (shelved), ` +
      `${skippedNoCountry} (no/unmapped country), ${skippedNoName} (no name).`,
  );
  if (unmappedCountries.size > 0) {
    console.warn(`  ${unmappedCountries.size} unmapped country names:`);
    const sorted = [...unmappedCountries.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
    for (const [k, v] of sorted) console.warn(`    ${k}: ${v}`);
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
