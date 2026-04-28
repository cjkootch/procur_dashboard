/**
 * FracTracker Alliance — Global Oil Refinery Complex and Daily Capacity ingest.
 *
 * Source: https://services.arcgis.com/jDGuO8tYggdCCnUJ/arcgis/rest/services/
 *         Global_Oil_Refinery_Complex_and_Daily_Capacity/FeatureServer/0
 *   (compiled and maintained by Ted Auch / The FracTracker Alliance,
 *    publicly queryable via the ArcGIS REST API)
 * License: not stated on the layer; FracTracker publishes most map data
 *   under CC-BY-SA-4.0 by default. Attribute "FracTracker Alliance"
 *   downstream.
 * Coverage: ~536 refineries globally with name, capacity (bbl/d),
 *   country, state/province, city, and lat/lng. Better global coverage
 *   than Wikipedia's master article and lighter to ingest than GEM
 *   (no data-request form, no file upload).
 *
 * Routes through findOrUpsertEntity. Source priority is set to
 * 'wikidata' tier — analyst-curated single-org dataset, similar
 * provenance level to Wikidata refineries. Won't overwrite curated
 * or GEM rows; will enrich OSM rows.
 *
 * Run: pnpm --filter @procur/db ingest-fractracker-refineries
 */
import 'dotenv/config';
import { config as loadEnv } from 'dotenv';
import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import * as schema from './schema';
import { findOrUpsertEntity } from './lib/find-or-upsert-entity';

loadEnv({ path: '../../.env.local' });
loadEnv({ path: '../../.env' });

const FEATURESERVER =
  'https://services.arcgis.com/jDGuO8tYggdCCnUJ/arcgis/rest/services/Global_Oil_Refinery_Complex_and_Daily_Capacity/FeatureServer/0';

/**
 * Country-name → ISO-2 lookup. FracTracker uses common English names
 * with US-centric spellings ("Russia", "United States", "South Korea").
 * Covers every country that appears in the layer plus a few aliases.
 */
const COUNTRY_NAME_TO_ISO2: Record<string, string> = {
  'united states': 'US', 'united states of america': 'US', 'usa': 'US', 'u.s.': 'US',
  'china': 'CN', "people's republic of china": 'CN',
  'india': 'IN', 'russia': 'RU', 'russian federation': 'RU',
  'japan': 'JP', 'south korea': 'KR', 'korea, south': 'KR', 'republic of korea': 'KR',
  'north korea': 'KP', "korea, democratic people's republic of": 'KP',
  'saudi arabia': 'SA', 'iran': 'IR', 'iraq': 'IQ', 'kuwait': 'KW',
  'qatar': 'QA', 'united arab emirates': 'AE', 'uae': 'AE', 'oman': 'OM',
  'turkey': 'TR', 'türkiye': 'TR', 'turkiye': 'TR',
  'germany': 'DE', 'france': 'FR', 'italy': 'IT', 'spain': 'ES',
  'united kingdom': 'GB', 'uk': 'GB', 'great britain': 'GB',
  'netherlands': 'NL', 'belgium': 'BE',
  'greece': 'GR', 'portugal': 'PT', 'sweden': 'SE', 'finland': 'FI',
  'norway': 'NO', 'austria': 'AT', 'hungary': 'HU', 'czechia': 'CZ',
  'czech republic': 'CZ', 'slovakia': 'SK', 'poland': 'PL',
  'romania': 'RO', 'bulgaria': 'BG', 'croatia': 'HR', 'serbia': 'RS',
  'bosnia and herzegovina': 'BA', 'slovenia': 'SI', 'albania': 'AL',
  'north macedonia': 'MK', 'macedonia': 'MK',
  'ukraine': 'UA', 'belarus': 'BY', 'moldova': 'MD',
  'switzerland': 'CH', 'denmark': 'DK', 'ireland': 'IE',
  'iceland': 'IS', 'lithuania': 'LT', 'latvia': 'LV', 'estonia': 'EE',
  'cyprus': 'CY', 'malta': 'MT',
  'canada': 'CA', 'mexico': 'MX', 'brazil': 'BR', 'argentina': 'AR',
  'venezuela': 'VE', 'colombia': 'CO', 'chile': 'CL', 'peru': 'PE',
  'ecuador': 'EC', 'bolivia': 'BO', 'cuba': 'CU', 'paraguay': 'PY',
  'uruguay': 'UY', 'guatemala': 'GT', 'honduras': 'HN', 'nicaragua': 'NI',
  'costa rica': 'CR', 'panama': 'PA', 'el salvador': 'SV',
  'trinidad and tobago': 'TT', 'jamaica': 'JM', 'dominican republic': 'DO',
  'haiti': 'HT', 'bahamas': 'BS',
  'south africa': 'ZA', 'nigeria': 'NG', 'egypt': 'EG', 'algeria': 'DZ',
  'libya': 'LY', 'morocco': 'MA', 'tunisia': 'TN', 'angola': 'AO',
  'kenya': 'KE', 'ghana': 'GH', 'tanzania': 'TZ', 'sudan': 'SD',
  'south sudan': 'SS', 'ethiopia': 'ET', 'ivory coast': 'CI',
  "côte d'ivoire": 'CI', 'cote d ivoire': 'CI', 'senegal': 'SN',
  'cameroon': 'CM', 'gabon': 'GA', 'congo': 'CG',
  'democratic republic of the congo': 'CD', 'dr congo': 'CD',
  'zambia': 'ZM', 'zimbabwe': 'ZW', 'mozambique': 'MZ', 'madagascar': 'MG',
  'uganda': 'UG', 'mauritius': 'MU', 'somalia': 'SO',
  'mauritania': 'MR', 'niger': 'NE', 'mali': 'ML', 'burkina faso': 'BF',
  'chad': 'TD', 'eritrea': 'ER', 'djibouti': 'DJ',
  'indonesia': 'ID', 'malaysia': 'MY', 'singapore': 'SG',
  'thailand': 'TH', 'vietnam': 'VN', 'philippines': 'PH',
  'pakistan': 'PK', 'bangladesh': 'BD', 'sri lanka': 'LK', 'myanmar': 'MM', 'burma': 'MM',
  'australia': 'AU', 'new zealand': 'NZ', 'kazakhstan': 'KZ',
  'azerbaijan': 'AZ', 'turkmenistan': 'TM', 'uzbekistan': 'UZ',
  'kyrgyzstan': 'KG', 'tajikistan': 'TJ', 'afghanistan': 'AF',
  'mongolia': 'MN', 'bhutan': 'BT', 'nepal': 'NP', 'maldives': 'MV',
  'israel': 'IL', 'jordan': 'JO', 'lebanon': 'LB', 'syria': 'SY',
  'yemen': 'YE', 'palestine': 'PS', 'georgia': 'GE', 'armenia': 'AM',
  'bahrain': 'BH',
};

function nameToIso2(name: string | null | undefined): string | null {
  if (!name) return null;
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
  return `ft-${country.toLowerCase() || 'xx'}-${base}`;
}

/** FracTracker uses "." or " " as a sentinel for missing string values. */
function cleanStr(s: string | null | undefined): string | null {
  if (s == null) return null;
  const t = s.trim();
  if (!t || t === '.' || t === '0' || t === '0.00') return null;
  return t;
}

/** Capacity = 0 means "unknown" rather than "literal zero". */
function cleanNum(n: number | null | undefined): number | null {
  if (n == null) return null;
  if (!Number.isFinite(n)) return null;
  if (n === 0) return null;
  return n;
}

type Attrs = {
  Name?: string;
  Company?: string;
  City?: string;
  Prov_State?: string;
  Country?: string;
  Capacity?: number;
  Longitude?: number;
  Latitude?: number;
  Status?: string;
  Link?: string;
};

type Feature = { attributes: Attrs };

async function fetchPage(offset: number, pageSize: number): Promise<Feature[]> {
  const params = new URLSearchParams({
    where: '1=1',
    outFields: 'Name,Company,City,Prov_State,Country,Capacity,Longitude,Latitude,Status,Link',
    f: 'json',
    resultOffset: String(offset),
    resultRecordCount: String(pageSize),
    orderByFields: 'FID',
    returnGeometry: 'false',
  });
  const res = await fetch(`${FEATURESERVER}/query?${params}`);
  if (!res.ok) throw new Error(`FracTracker ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as { features?: Feature[] };
  return json.features ?? [];
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set');

  console.log('Fetching FracTracker Global Oil Refinery layer...');
  const all: Feature[] = [];
  const pageSize = 1000;
  for (let offset = 0; ; offset += pageSize) {
    const batch = await fetchPage(offset, pageSize);
    all.push(...batch);
    console.log(`  fetched ${all.length} so far (last batch: ${batch.length})`);
    if (batch.length < pageSize) break;
    if (offset > 50_000) break; // safety guard
  }
  console.log(`  ${all.length} total features.`);

  const client = neon(url);
  const db = drizzle(client, { schema, casing: 'snake_case' });

  let inserted = 0;
  let merged = 0;
  let skippedNoCountry = 0;
  let skippedNoName = 0;
  const unmappedCountries = new Map<string, number>();

  for (const f of all) {
    const a = f.attributes;
    const name = cleanStr(a.Name);
    if (!name) {
      skippedNoName += 1;
      continue;
    }
    const country = nameToIso2(a.Country);
    if (!country) {
      skippedNoCountry += 1;
      const display = (a.Country ?? '<none>').slice(0, 40);
      unmappedCountries.set(display, (unmappedCountries.get(display) ?? 0) + 1);
      continue;
    }

    const company = cleanStr(a.Company);
    const city = cleanStr(a.City);
    const provState = cleanStr(a.Prov_State);
    const capacityBpd = cleanNum(a.Capacity);
    const status = cleanStr(a.Status);
    const link = cleanStr(a.Link);
    const lat = cleanNum(a.Latitude);
    const lon = cleanNum(a.Longitude);

    const noteParts: string[] = [];
    if (company) noteParts.push(`Company: ${company}`);
    if (capacityBpd) noteParts.push(`Capacity: ${capacityBpd.toLocaleString()} bpd`);
    const locParts = [city, provState].filter(Boolean) as string[];
    if (locParts.length > 0) noteParts.push(`Location: ${locParts.join(', ')}`);
    if (status) noteParts.push(`Status: ${status}`);
    if (link) noteParts.push(`Link: ${link}`);
    noteParts.push('Source: FracTracker Alliance');

    const tags = ['refinery', 'source:fractracker'];
    if (capacityBpd != null) {
      if (capacityBpd >= 400_000) tags.push('size:mega');
      else if (capacityBpd >= 200_000) tags.push('size:large');
      else if (capacityBpd >= 100_000) tags.push('size:mid');
      else tags.push('size:small');
    }
    if (status) tags.push(`status:${status.toLowerCase().replace(/\s+/g, '-')}`);
    const med = ['IT', 'ES', 'FR', 'GR', 'TR', 'CY', 'MT', 'HR', 'SI', 'AL'];
    if (med.includes(country)) tags.push('region:mediterranean');

    const result = await findOrUpsertEntity(db, {
      slug: slugify(name, country),
      // Wikidata tier: single-org analyst-curated. Won't overwrite
      // curated/GEM rows; will enrich OSM rows.
      source: 'wikidata',
      name,
      country,
      role: 'refiner',
      categories: ['crude-oil', 'diesel', 'gasoline', 'jet-fuel'],
      notes: noteParts.join(' · '),
      aliases: [name],
      tags,
      latitude: lat,
      longitude: lon,
      metadata: {
        operator: company,
        capacity_bpd: capacityBpd,
        city,
        province_state: provState,
        status,
        info_link: link,
        fractracker_source:
          'Global_Oil_Refinery_Complex_and_Daily_Capacity (Ted Auch / FracTracker Alliance)',
      },
    });
    if (result.outcome === 'inserted') inserted += 1;
    else merged += 1;
  }

  console.log(
    `Done. inserted=${inserted}, merged=${merged} (enriched existing rows), skipped=${skippedNoCountry} (no country), ${skippedNoName} (no name).`,
  );
  if (unmappedCountries.size > 0 && unmappedCountries.size <= 30) {
    console.log('  Most-common unmapped country values:');
    const sorted = [...unmappedCountries.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15);
    for (const [k, v] of sorted) console.log(`    ${k}: ${v}`);
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
