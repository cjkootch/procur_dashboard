/**
 * OpenStreetMap refinery ingest via Overpass API.
 *
 * Source: https://overpass-api.de/api/interpreter (no auth, free)
 * License: ODbL (data) — same license OSM uses
 * Coverage: ~300-600 globally with name + lat/lng, partial operator
 *   tagging. Less authoritative than GEM but always-available and
 *   free of request forms.
 *
 * Tagging convention: features with industrial=refinery + a name tag.
 * Country derivation prefers addr:country (ISO-2), then is_in:country,
 * then admin-area lookup. Rows without a resolvable country are
 * logged + skipped.
 *
 * Goes through findOrUpsertEntity so OSM rows enrich existing curated/
 * Wikidata/GEM entries by fuzzy match. Standalone OSM rows get osm-*
 * slugs.
 *
 * Run: pnpm --filter @procur/db ingest-osm-refineries
 */
import 'dotenv/config';
import { config as loadEnv } from 'dotenv';
import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import * as schema from './schema';
import { findOrUpsertEntity } from './lib/find-or-upsert-entity';

loadEnv({ path: '../../.env.local' });
loadEnv({ path: '../../.env' });

const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';

/**
 * Overpass QL query: every node/way/relation tagged industrial=refinery
 * that also has a name. Includes addr:country and is_in:country tags
 * when present so we can resolve location. `out center` gives us a
 * single lat/lng for ways and relations (their geometric centroid).
 */
const OVERPASS_QUERY = `
[out:json][timeout:120];
(
  node["industrial"="refinery"]["name"];
  way["industrial"="refinery"]["name"];
  relation["industrial"="refinery"]["name"];
);
out center tags;
`;

type OsmElement = {
  type: 'node' | 'way' | 'relation';
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
};

type OverpassResponse = {
  elements?: OsmElement[];
};

/** Common country-name → ISO-2. Same shape as the GEM ingest's table. */
const COUNTRY_NAME_TO_ISO2: Record<string, string> = {
  'united states': 'US', 'united states of america': 'US', 'usa': 'US',
  'china': 'CN', 'india': 'IN', 'russia': 'RU',
  'russian federation': 'RU',
  'japan': 'JP', 'south korea': 'KR', 'korea': 'KR',
  'saudi arabia': 'SA', 'iran': 'IR', 'iraq': 'IQ', 'kuwait': 'KW',
  'qatar': 'QA', 'united arab emirates': 'AE', 'oman': 'OM',
  'turkey': 'TR', 'türkiye': 'TR', 'turkiye': 'TR',
  'germany': 'DE', 'france': 'FR', 'italy': 'IT', 'spain': 'ES',
  'united kingdom': 'GB', 'uk': 'GB', 'great britain': 'GB',
  'netherlands': 'NL', 'belgium': 'BE',
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
  'israel': 'IL', 'jordan': 'JO', 'lebanon': 'LB', 'syria': 'SY',
  'yemen': 'YE',
};

function resolveCountry(tags: Record<string, string>): string | null {
  // Prefer ISO-2 tags first
  const direct = (tags['addr:country'] ?? tags['country'])?.trim();
  if (direct && /^[A-Z]{2}$/.test(direct)) return direct;
  // Then country-name tags
  const candidates = [
    direct,
    tags['is_in:country'],
    tags['is_in:country_code'],
    tags['is_in'],
  ];
  for (const c of candidates) {
    if (!c) continue;
    const k = c.trim().toLowerCase();
    const iso = COUNTRY_NAME_TO_ISO2[k];
    if (iso) return iso;
  }
  return null;
}

function slugify(name: string, country: string, osmType: string, osmId: number): string {
  const base = name
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `osm-${country.toLowerCase() || 'xx'}-${base}-${osmType}${osmId}`;
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set');

  console.log('Querying OpenStreetMap Overpass API for refineries...');
  const res = await fetch(OVERPASS_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
      'User-Agent': 'procur-research/1.0 (cole@vectortradecapital.com)',
    },
    body: `data=${encodeURIComponent(OVERPASS_QUERY)}`,
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Overpass ${res.status}: ${body.slice(0, 500)}`);
  }
  const json = (await res.json()) as OverpassResponse;
  const elements = json.elements ?? [];
  console.log(`  ${elements.length} OSM features tagged industrial=refinery with names`);

  const client = neon(url);
  const db = drizzle(client, { schema, casing: 'snake_case' });

  let inserted = 0;
  let merged = 0;
  let skippedNoCountry = 0;
  let skippedNoCoords = 0;
  const unknownCountries = new Map<string, number>();

  for (const el of elements) {
    const tags = el.tags ?? {};
    const name = tags.name?.trim();
    if (!name) continue;
    const country = resolveCountry(tags);
    if (!country) {
      skippedNoCountry += 1;
      const display =
        (tags['addr:country'] ?? tags['is_in:country'] ?? tags['is_in'] ?? '<none>').slice(
          0,
          40,
        );
      unknownCountries.set(display, (unknownCountries.get(display) ?? 0) + 1);
      continue;
    }
    const lat = el.lat ?? el.center?.lat;
    const lon = el.lon ?? el.center?.lon;
    if (lat == null || lon == null) {
      skippedNoCoords += 1;
      continue;
    }

    const operator = tags.operator ?? tags['operator:short'] ?? null;
    const wikidataId = tags.wikidata ?? null;
    const noteParts: string[] = [];
    if (operator) noteParts.push(`Operator: ${operator}`);
    if (tags.start_date) noteParts.push(`Started: ${tags.start_date.slice(0, 4)}`);
    noteParts.push(`Source: OpenStreetMap (${el.type}/${el.id})`);

    const tagList = ['refinery', 'source:osm'];
    const med = ['IT', 'ES', 'FR', 'GR', 'TR', 'CY', 'MT', 'HR', 'SI', 'AL'];
    if (med.includes(country)) tagList.push('region:mediterranean');
    const asia = ['IN', 'ID', 'PK', 'BD', 'LK', 'TH', 'VN', 'PH', 'MY'];
    if (asia.includes(country)) tagList.push('region:asia-state');

    const result = await findOrUpsertEntity(db, {
      slug: slugify(name, country, el.type, el.id),
      source: 'osm',
      name,
      country,
      role: 'refiner',
      categories: ['crude-oil', 'diesel', 'gasoline', 'jet-fuel'],
      notes: noteParts.join(' · '),
      aliases: [name],
      tags: tagList,
      latitude: lat,
      longitude: lon,
      metadata: {
        osm_id: `${el.type}/${el.id}`,
        wikidata_id: wikidataId,
        operator,
      },
    });
    if (result.outcome === 'inserted') inserted += 1;
    else merged += 1;
  }

  console.log(
    `Done. inserted=${inserted}, merged=${merged} (enriched existing rows), skipped=${skippedNoCountry} (no country), ${skippedNoCoords} (no coords).`,
  );
  if (unknownCountries.size > 0 && unknownCountries.size <= 30) {
    console.log('  Most-common unmapped country values:');
    const sorted = [...unknownCountries.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
    for (const [k, v] of sorted) console.log(`    ${k}: ${v}`);
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
