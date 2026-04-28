/**
 * Global Energy Monitor — Global Oil and Gas Plant Tracker (GOGPT) ingest.
 *
 * Source: GEM Trackers hub (download requires data-request form)
 * License: CC-BY-4.0
 * Coverage: ~14,000 power plant units globally that burn oil or gas.
 *
 * Why this matters for VTC: power plants are MASSIVE refined-fuel
 * buyers. Oil-fired and dual-fuel (oil+gas) plants consume hundreds
 * of thousands of bbl/d of heavy fuel oil + diesel + gas oil globally.
 * Adding them to the rolodex as `role: 'power-plant'` gives a buy-
 * side surface for refined-fuel sales.
 *
 * Default filters:
 *   - Fuel includes "fossil liquids" or "fuel oil" or "diesel"
 *     (skip pure-gas; --include-gas to keep them)
 *   - Status in {operating, under construction, pre-construction,
 *     announced} (skip retired/cancelled/mothballed; --include-shelved
 *     to keep)
 *
 * Aggregation: GOGPT has one row per UNIT (multiple units per plant).
 * We group by (plant_name, country), sum capacity, take the most-
 * frequent operator/owner/parent across units. One entity per plant.
 *
 * Run:
 *   pnpm --filter @procur/db ingest-gem-power-plants <path-to-gogpt.xlsx>
 *   pnpm --filter @procur/db ingest-gem-power-plants <path> --include-gas
 *   pnpm --filter @procur/db ingest-gem-power-plants <path> --include-shelved
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

const SHEETS_TO_READ = ['Gas & Oil Units', 'sub-threshold units'];

const COUNTRY_NAME_TO_ISO2: Record<string, string> = {
  // Reusing the same shape as other GEM ingests. Trimmed for brevity to
  // the most-common power-plant countries (will skip + log unknowns).
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
  'ecuador': 'EC', 'cuba': 'CU',
  'trinidad and tobago': 'TT', 'jamaica': 'JM', 'dominican republic': 'DO',
  'south africa': 'ZA', 'nigeria': 'NG', 'egypt': 'EG', 'algeria': 'DZ',
  'libya': 'LY', 'morocco': 'MA', 'tunisia': 'TN', 'angola': 'AO',
  'kenya': 'KE', 'ghana': 'GH', 'tanzania': 'TZ', 'sudan': 'SD',
  'south sudan': 'SS', 'gabon': 'GA', 'cameroon': 'CM',
  'côte d\'ivoire': 'CI', 'cote d ivoire': 'CI', 'ivory coast': 'CI',
  'senegal': 'SN', 'mauritania': 'MR', 'ethiopia': 'ET',
  'mozambique': 'MZ', 'madagascar': 'MG', 'zimbabwe': 'ZW', 'zambia': 'ZM',
  'indonesia': 'ID', 'malaysia': 'MY', 'singapore': 'SG',
  'thailand': 'TH', 'vietnam': 'VN', 'philippines': 'PH',
  'pakistan': 'PK', 'bangladesh': 'BD', 'sri lanka': 'LK', 'myanmar': 'MM',
  'australia': 'AU', 'new zealand': 'NZ', 'kazakhstan': 'KZ',
  'azerbaijan': 'AZ', 'turkmenistan': 'TM', 'uzbekistan': 'UZ',
  'israel': 'IL', 'jordan': 'JO', 'lebanon': 'LB', 'syria': 'SY',
  'yemen': 'YE', 'afghanistan': 'AF',
  'bahrain': 'BH', 'taiwan': 'TW', 'hong kong': 'HK',
  'cambodia': 'KH', 'laos': 'LA',
  'haiti': 'HT', 'guyana': 'GY', 'suriname': 'SR',
  'panama': 'PA', 'guatemala': 'GT', 'honduras': 'HN', 'nicaragua': 'NI',
  'el salvador': 'SV', 'costa rica': 'CR', 'belize': 'BZ',
  'puerto rico': 'PR',
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
  return `gem-pp-${country.toLowerCase() || 'xx'}-${base}`;
}

const ACTIVE_STATUSES = new Set([
  'operating',
  'under construction',
  'pre-construction',
  'announced',
  'permitted',
]);

const SHELVED_STATUSES = new Set([
  'shelved',
  'cancelled',
  'mothballed',
  'retired',
  'decommissioned',
]);

/** Returns true if the fuel string indicates the plant burns oil-derived
 *  liquid fuel. GOGPT uses formats like "fossil liquids: fuel oil" or
 *  comma-separated combinations for dual-fuel plants. */
function burnsOil(fuel: string | null): boolean {
  if (!fuel) return false;
  const f = fuel.toLowerCase();
  return (
    f.includes('fossil liquids') ||
    f.includes('fuel oil') ||
    f.includes('diesel') ||
    f.includes('gas oil') ||
    f.includes('heavy fuel') ||
    f.includes('crude') ||
    f.includes('residual oil')
  );
}

function burnsGas(fuel: string | null): boolean {
  if (!fuel) return false;
  return /\b(natural gas|fossil gas|lng|cng)\b/i.test(fuel);
}

/** Pick a category-tag set based on what fuel the plant burns. Used
 *  to make the entity discoverable via category filters in the rolodex. */
function fuelToCategories(fuel: string | null): string[] {
  const cats: string[] = [];
  if (!fuel) return cats;
  const f = fuel.toLowerCase();
  if (f.includes('fuel oil') || f.includes('residual oil') || f.includes('heavy fuel')) {
    cats.push('heavy-fuel-oil');
  }
  if (f.includes('diesel') || f.includes('gas oil')) {
    cats.push('diesel');
  }
  // Generic "fossil liquids" without specifics — most likely fuel oil at scale
  if (f.includes('fossil liquids') && cats.length === 0) {
    cats.push('heavy-fuel-oil');
  }
  if (f.includes('crude')) {
    cats.push('crude-oil');
  }
  // Gas plants buy LPG-adjacent fuel (LNG / CNG); only include if user
  // opted in and only for the buy-side discoverability angle
  if (burnsGas(fuel)) {
    cats.push('lpg');
  }
  return Array.from(new Set(cats));
}

type RawUnit = {
  country: string;
  plantName: string;
  unitName: string | null;
  fuel: string | null;
  capacityMw: number | null;
  status: string;
  operator: string | null;
  owner: string | null;
  parent: string | null;
  startYear: number | null;
  latitude: number | null;
  longitude: number | null;
  wikiUrl: string | null;
};

type AggregatedPlant = {
  country: string;
  plantName: string;
  totalCapacityMw: number;
  unitCount: number;
  fuels: Set<string>;
  statuses: Set<string>;
  operators: Set<string>;
  owners: Set<string>;
  parents: Set<string>;
  earliestStartYear: number | null;
  latitude: number | null;
  longitude: number | null;
  wikiUrl: string | null;
};

function aggregate(units: RawUnit[]): AggregatedPlant[] {
  const byKey = new Map<string, AggregatedPlant>();
  for (const u of units) {
    const key = `${u.country}::${u.plantName}`;
    let agg = byKey.get(key);
    if (!agg) {
      agg = {
        country: u.country,
        plantName: u.plantName,
        totalCapacityMw: 0,
        unitCount: 0,
        fuels: new Set(),
        statuses: new Set(),
        operators: new Set(),
        owners: new Set(),
        parents: new Set(),
        earliestStartYear: null,
        latitude: null,
        longitude: null,
        wikiUrl: null,
      };
      byKey.set(key, agg);
    }
    agg.unitCount += 1;
    if (u.capacityMw != null) agg.totalCapacityMw += u.capacityMw;
    if (u.fuel) agg.fuels.add(u.fuel);
    agg.statuses.add(u.status);
    if (u.operator) agg.operators.add(u.operator);
    if (u.owner) agg.owners.add(u.owner);
    if (u.parent) agg.parents.add(u.parent);
    if (u.startYear != null) {
      agg.earliestStartYear =
        agg.earliestStartYear == null
          ? u.startYear
          : Math.min(agg.earliestStartYear, u.startYear);
    }
    if (agg.latitude == null && u.latitude != null) agg.latitude = u.latitude;
    if (agg.longitude == null && u.longitude != null) agg.longitude = u.longitude;
    if (!agg.wikiUrl && u.wikiUrl) agg.wikiUrl = u.wikiUrl;
  }
  return [...byKey.values()];
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set');

  const args = process.argv.slice(2);
  const path = args.find((a) => !a.startsWith('--')) ?? process.env.GEM_GOGPT_PATH;
  const includeGas = args.includes('--include-gas');
  const includeShelved = args.includes('--include-shelved');

  if (!path) {
    console.error(
      'Usage: pnpm --filter @procur/db ingest-gem-power-plants <path-to-gogpt.xlsx>\n' +
        '  --include-gas      keep pure-gas plants (default: oil-burning only)\n' +
        '  --include-shelved  keep retired/cancelled plants',
    );
    process.exit(1);
  }
  console.log(`Reading GOGPT from ${path}...`);
  console.log(`  filters: oil-only=${!includeGas}, active-only=${!includeShelved}`);

  const allUnits: RawUnit[] = [];
  for (const sheet of SHEETS_TO_READ) {
    let rows: Array<Record<string, string>>;
    try {
      rows = await readTabular(path, sheet);
    } catch {
      console.warn(`  sheet "${sheet}" not found — skipping`);
      continue;
    }
    console.log(`  ${sheet}: ${rows.length} unit rows`);

    let kept = 0;
    let droppedFuel = 0;
    let droppedStatus = 0;
    let droppedCountry = 0;
    const unmappedCountries = new Map<string, number>();

    for (const row of rows) {
      const plantName = pickCol(row, 'Plant name', 'Plant Name', 'Project Name');
      const countryName = pickCol(row, 'Country/Area', 'Country');
      if (!plantName || !countryName) continue;
      const country = nameToIso2(countryName);
      if (!country) {
        droppedCountry += 1;
        unmappedCountries.set(countryName, (unmappedCountries.get(countryName) ?? 0) + 1);
        continue;
      }

      const fuel = pickCol(row, 'Fuel', 'Fuel Type');
      const oil = burnsOil(fuel);
      const gas = burnsGas(fuel);
      // Default: oil-burning OR dual-fuel. Skip pure-gas unless --include-gas.
      if (!oil && !(includeGas && gas)) {
        droppedFuel += 1;
        continue;
      }

      const status = (pickCol(row, 'Status') ?? '').toLowerCase();
      const isActive = ACTIVE_STATUSES.has(status);
      const isShelved = SHELVED_STATUSES.has(status);
      if (!isActive && !(includeShelved && isShelved)) {
        droppedStatus += 1;
        continue;
      }

      allUnits.push({
        country,
        plantName,
        unitName: pickCol(row, 'Unit name'),
        fuel,
        capacityMw: parseNumberSafe(pickCol(row, 'Capacity (MW)', 'Capacity')),
        status,
        operator: pickCol(row, 'Operator(s)', 'Operator'),
        owner: pickCol(row, 'Owner(s)', 'Owner'),
        parent: pickCol(row, 'Parent(s)', 'Parent'),
        startYear: parseNumberSafe(pickCol(row, 'Start year', 'Start Year', 'Year')),
        latitude: parseNumberSafe(pickCol(row, 'Latitude')),
        longitude: parseNumberSafe(pickCol(row, 'Longitude')),
        wikiUrl: pickCol(row, 'Wiki URL'),
      });
      kept += 1;
    }
    console.log(
      `    kept=${kept}, droppedFuel=${droppedFuel}, droppedStatus=${droppedStatus}, droppedCountry=${droppedCountry}`,
    );
    if (unmappedCountries.size > 0 && unmappedCountries.size <= 8) {
      for (const [c, n] of unmappedCountries) {
        console.warn(`      unmapped country: ${c} (${n} rows)`);
      }
    }
  }

  console.log(`\n  ${allUnits.length} total kept units across sheets`);
  const plants = aggregate(allUnits);
  console.log(`  ${plants.length} unique plants after aggregation`);

  const client = neon(url);
  const db = drizzle(client, { schema, casing: 'snake_case' });

  let inserted = 0;
  let merged = 0;

  for (const p of plants) {
    const operators = [...p.operators];
    const owners = [...p.owners];
    const parents = [...p.parents];
    const fuels = [...p.fuels];
    const statuses = [...p.statuses];

    const noteParts: string[] = [];
    if (operators.length) noteParts.push(`Operator: ${operators.slice(0, 3).join(', ')}`);
    if (owners.length && owners[0] !== operators[0]) {
      noteParts.push(`Owner: ${owners.slice(0, 3).join(', ')}`);
    }
    if (parents.length) noteParts.push(`Parent: ${parents.slice(0, 3).join(', ')}`);
    if (p.totalCapacityMw > 0) {
      noteParts.push(`Capacity: ${Math.round(p.totalCapacityMw).toLocaleString()} MW (${p.unitCount} unit${p.unitCount === 1 ? '' : 's'})`);
    }
    if (fuels.length) noteParts.push(`Fuel: ${fuels.slice(0, 2).join(' | ')}`);
    if (p.earliestStartYear) noteParts.push(`Started: ${p.earliestStartYear}`);
    if (statuses.length) noteParts.push(`Status: ${statuses.slice(0, 2).join(', ')}`);
    noteParts.push('Source: GEM Global Oil and Gas Plant Tracker');

    // Roll capacity bucket on MW (different from refinery bbl/d ranges)
    const tags: string[] = ['power-plant'];
    if (p.totalCapacityMw >= 2000) tags.push('size:mega');
    else if (p.totalCapacityMw >= 500) tags.push('size:large');
    else if (p.totalCapacityMw >= 100) tags.push('size:mid');
    else tags.push('size:small');
    for (const s of statuses) tags.push(`status:${s.replace(/\s+/g, '-')}`);
    if (fuels.some((f) => burnsOil(f) && burnsGas(f))) tags.push('fuel:dual');
    else if (fuels.some(burnsOil)) tags.push('fuel:oil');
    else if (fuels.some(burnsGas)) tags.push('fuel:gas');

    // Compose categories from all this plant's fuels
    const categories = new Set<string>();
    for (const f of fuels) for (const c of fuelToCategories(f)) categories.add(c);
    if (categories.size === 0) categories.add('heavy-fuel-oil'); // safety default

    const result = await findOrUpsertEntity(db, {
      slug: slugify(p.plantName, p.country),
      source: 'gem',
      name: p.plantName,
      country: p.country,
      role: 'power-plant',
      categories: [...categories],
      notes: noteParts.join(' · '),
      aliases: [p.plantName],
      tags,
      latitude: p.latitude,
      longitude: p.longitude,
      metadata: {
        operators,
        owners,
        parents,
        fuels,
        statuses,
        capacity_mw: p.totalCapacityMw,
        unit_count: p.unitCount,
        start_year: p.earliestStartYear,
        wiki_url: p.wikiUrl,
      },
    });
    if (result.outcome === 'inserted') inserted += 1;
    else merged += 1;
  }

  console.log(`\nDone. inserted=${inserted}, merged=${merged} (enriched existing rows).`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
