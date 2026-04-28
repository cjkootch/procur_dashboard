/**
 * Ingest oil refineries from Wikidata into known_entities.
 *
 * Wikidata is the most accessible public refinery dataset:
 *   - SPARQL endpoint at https://query.wikidata.org/sparql
 *   - No auth, no cost, no rate limit beyond polite usage
 *   - ~700 refineries globally with country, operator, capacity
 *   - CC0-licensed (public domain)
 *
 * This script issues a single SPARQL query, normalizes the response
 * into known_entities rows, and upserts on slug. Idempotent —
 * re-running is safe and updates fields on existing rows.
 *
 * Run from repo root:
 *   pnpm --filter @procur/db ingest-wikidata-refineries
 *
 * Wikidata properties used:
 *   P31  — instance of            (filter: subclass of Q235365 oil refinery)
 *   P17  — country
 *   P137 — operator
 *   P127 — owned by
 *   P3712 — operating capacity (in volume)  [often null; coverage ~60%]
 *   P571 — inception (startup year)
 *   P5817 — state of operation     (operating / decommissioned / under construction)
 *
 * Capacity is usually expressed in barrels per day. We normalize to
 * an integer count + unit string in metadata; the schema doesn't
 * carry capacity as a top-level column on purpose — keep the curated
 * rolodex schema-light and let downstream views project what they need.
 */

import 'dotenv/config';
import { config as loadEnv } from 'dotenv';
import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import * as schema from './schema';

loadEnv({ path: '../../.env.local' });
loadEnv({ path: '../../.env' });

const SPARQL_ENDPOINT = 'https://query.wikidata.org/sparql';

/**
 * Q-IDs Wikidata uses for oil/petroleum refineries. Q235365 is the
 * abstract "oil refinery" class — most actual refinery items are
 * instances of one of its subclasses. Enumerating them explicitly is
 * way faster than `wdt:P31/wdt:P279*` (which times out on the free
 * tier) and gives broader coverage than instance-of-Q235365 alone
 * (which returns ~30 rows).
 *
 * If you suspect coverage gaps, run this in the Wikidata Query Service
 * to find candidates:
 *   SELECT ?c ?cLabel WHERE { ?c wdt:P279* wd:Q235365 .
 *     SERVICE wikibase:label { bd:serviceParam wikibase:language "en" . } }
 */
const REFINERY_CLASSES = [
  'wd:Q235365',   // oil refinery
  'wd:Q1019358',  // petroleum refinery (most common direct class)
  'wd:Q1521410',  // petroleum products refinery
  'wd:Q11516670', // crude oil refinery
];

const SPARQL_QUERY = `
SELECT ?refinery ?refineryLabel ?countryCode ?operatorLabel ?ownerLabel
       ?capacity ?capacityUnit ?statusLabel ?inception ?coord
WHERE {
  VALUES ?refineryClass { ${REFINERY_CLASSES.join(' ')} }
  ?refinery wdt:P31 ?refineryClass .
  OPTIONAL {
    ?refinery wdt:P17 ?country .
    ?country wdt:P298 ?countryCode .
  }
  OPTIONAL { ?refinery wdt:P137 ?operator . }
  OPTIONAL { ?refinery wdt:P127 ?owner . }
  OPTIONAL {
    ?refinery p:P3712 ?capStmt .
    ?capStmt psv:P3712 ?capValue .
    ?capValue wikibase:quantityAmount ?capacity .
    ?capValue wikibase:quantityUnit ?capacityUnit .
  }
  OPTIONAL { ?refinery wdt:P5817 ?status . }
  OPTIONAL { ?refinery wdt:P571 ?inception . }
  OPTIONAL { ?refinery wdt:P625 ?coord . }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en" . }
}
LIMIT 2000
`;

type SparqlBinding<T> = { value: T };
type SparqlRow = {
  refinery: SparqlBinding<string>;
  refineryLabel?: SparqlBinding<string>;
  countryCode?: SparqlBinding<string>;
  operatorLabel?: SparqlBinding<string>;
  ownerLabel?: SparqlBinding<string>;
  capacity?: SparqlBinding<string>;
  capacityUnit?: SparqlBinding<string>;
  statusLabel?: SparqlBinding<string>;
  inception?: SparqlBinding<string>;
  coord?: SparqlBinding<string>;
};

async function fetchWikidata(): Promise<SparqlRow[]> {
  // POST is more reliable than GET for SPARQL — avoids URL-length
  // issues and is the form Wikidata's docs recommend for non-trivial
  // queries.
  const res = await fetch(SPARQL_ENDPOINT, {
    method: 'POST',
    headers: {
      Accept: 'application/sparql-results+json',
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'procur-research/1.0 (contact: cole@vectortradecapital.com)',
    },
    body: `query=${encodeURIComponent(SPARQL_QUERY)}`,
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Wikidata SPARQL ${res.status}: ${body.slice(0, 500)}`);
  }
  const text = await res.text();
  let json: {
    head?: { vars?: string[] };
    results?: { bindings?: SparqlRow[] };
  };
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Wikidata SPARQL returned non-JSON: ${text.slice(0, 500)}`);
  }
  const bindings = json.results?.bindings ?? [];
  if (bindings.length === 0) {
    // Diagnostic dump — helps identify whether the query was malformed,
    // the response shape changed, or anti-bot filtering kicked in.
    console.warn('Wikidata returned 0 rows. Diagnostics:');
    console.warn(`  HTTP status: ${res.status}`);
    console.warn(`  response keys: ${Object.keys(json).join(', ')}`);
    console.warn(`  head.vars: ${JSON.stringify(json.head?.vars ?? [])}`);
    console.warn(`  raw body (first 500 chars): ${text.slice(0, 500)}`);
    console.warn(
      '  Try the query manually at https://query.wikidata.org/ to verify Wikidata returns data; ' +
        'if it does, the issue is likely User-Agent or POST-encoding.',
    );
  }
  return bindings;
}

function slugify(name: string, country: string): string {
  const base = name
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `wd-${country.toLowerCase() || 'xx'}-${base}`;
}

function normalizeRow(row: SparqlRow): {
  slug: string;
  name: string;
  country: string;
  operator: string | null;
  owner: string | null;
  capacityBpd: number | null;
  status: string | null;
  inceptionYear: number | null;
  wikidataId: string;
  latitude: number | null;
  longitude: number | null;
} | null {
  const wikidataId = row.refinery.value.replace('http://www.wikidata.org/entity/', '');
  const name = row.refineryLabel?.value;
  const country = row.countryCode?.value ?? '';
  if (!name || name.startsWith('Q')) return null; // skip un-labeled rows

  // Wikidata operating capacity is usually m³/day or barrels/day.
  // Convert m³/day -> bpd at 6.2898 (industry standard).
  let capacityBpd: number | null = null;
  if (row.capacity?.value) {
    const raw = Number.parseFloat(row.capacity.value);
    if (Number.isFinite(raw) && raw > 0) {
      const unit = row.capacityUnit?.value ?? '';
      // Q12100 = cubic metre, Q1377612 = barrel per day. Falls back to bpd.
      if (unit.includes('Q12100')) {
        capacityBpd = Math.round(raw * 6.2898);
      } else {
        capacityBpd = Math.round(raw);
      }
    }
  }

  let inceptionYear: number | null = null;
  if (row.inception?.value) {
    const y = Number.parseInt(row.inception.value.slice(0, 4), 10);
    if (Number.isFinite(y) && y > 1850 && y < 2100) inceptionYear = y;
  }

  // Wikidata P625 returns WKT format "Point(longitude latitude)".
  // Note longitude FIRST per WKT/GeoJSON convention.
  let latitude: number | null = null;
  let longitude: number | null = null;
  if (row.coord?.value) {
    const m = row.coord.value.match(/^Point\(\s*(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s*\)/);
    if (m) {
      const lng = Number.parseFloat(m[1]!);
      const lat = Number.parseFloat(m[2]!);
      if (Number.isFinite(lng) && Number.isFinite(lat) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
        longitude = lng;
        latitude = lat;
      }
    }
  }

  return {
    slug: slugify(name, country || 'xx'),
    name,
    country: country || 'XX',
    operator: row.operatorLabel?.value ?? null,
    owner: row.ownerLabel?.value ?? null,
    capacityBpd,
    status: row.statusLabel?.value ?? null,
    inceptionYear,
    wikidataId,
    latitude,
    longitude,
  };
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set');

  const client = neon(url);
  const db = drizzle(client, { schema, casing: 'snake_case' });

  console.log('Querying Wikidata for oil refineries...');
  const rows = await fetchWikidata();
  console.log(`  ${rows.length} raw rows`);

  let upserted = 0;
  let skipped = 0;
  for (const raw of rows) {
    const r = normalizeRow(raw);
    if (!r) {
      skipped += 1;
      continue;
    }
    const notes = buildNotes(r);
    const tags = buildTags(r);

    await db
      .insert(schema.knownEntities)
      .values({
        slug: r.slug,
        name: r.name,
        country: r.country,
        role: 'refiner',
        categories: ['crude-oil', 'diesel', 'gasoline', 'jet-fuel'],
        notes,
        aliases: [r.name],
        tags,
        latitude: r.latitude != null ? String(r.latitude) : null,
        longitude: r.longitude != null ? String(r.longitude) : null,
        metadata: {
          source: 'wikidata',
          wikidata_id: r.wikidataId,
          operator: r.operator,
          owner: r.owner,
          capacity_bpd: r.capacityBpd,
          status: r.status,
          inception_year: r.inceptionYear,
        },
      })
      .onConflictDoUpdate({
        target: schema.knownEntities.slug,
        set: {
          name: r.name,
          country: r.country,
          notes,
          tags,
          latitude: r.latitude != null ? String(r.latitude) : null,
          longitude: r.longitude != null ? String(r.longitude) : null,
          metadata: {
            source: 'wikidata',
            wikidata_id: r.wikidataId,
            operator: r.operator,
            owner: r.owner,
            capacity_bpd: r.capacityBpd,
            status: r.status,
            inception_year: r.inceptionYear,
          },
          updatedAt: new Date(),
        },
      });
    upserted += 1;
  }
  console.log(`Done. upserted=${upserted}, skipped=${skipped} (unlabeled)`);
}

function buildNotes(r: NonNullable<ReturnType<typeof normalizeRow>>): string {
  const parts: string[] = [];
  if (r.operator) parts.push(`Operator: ${r.operator}`);
  if (r.owner && r.owner !== r.operator) parts.push(`Owner: ${r.owner}`);
  if (r.capacityBpd) parts.push(`Capacity: ${r.capacityBpd.toLocaleString()} bpd`);
  if (r.status) parts.push(`Status: ${r.status}`);
  if (r.inceptionYear) parts.push(`Started: ${r.inceptionYear}`);
  parts.push(`Source: Wikidata (${r.wikidataId})`);
  return parts.join(' · ');
}

function buildTags(r: NonNullable<ReturnType<typeof normalizeRow>>): string[] {
  const tags = ['refinery'];
  if (r.status) tags.push(`status:${r.status.toLowerCase().replace(/\s+/g, '-')}`);
  // Capacity bucket — useful for filtering big complex refineries
  if (r.capacityBpd != null) {
    if (r.capacityBpd >= 400_000) tags.push('size:mega');
    else if (r.capacityBpd >= 200_000) tags.push('size:large');
    else if (r.capacityBpd >= 100_000) tags.push('size:mid');
    else tags.push('size:small');
  }
  // Mediterranean buyers are top Libyan-crude candidates
  const med = ['IT', 'ES', 'FR', 'GR', 'TR', 'CY', 'MT', 'HR', 'SI', 'AL'];
  if (med.includes(r.country)) tags.push('region:mediterranean');
  // Asian state refiners are public-tender visible
  const asia = ['IN', 'ID', 'PK', 'BD', 'LK', 'TH', 'VN', 'PH', 'MY'];
  if (asia.includes(r.country)) tags.push('region:asia-state');
  return tags;
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
