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
 * Pulls every entity that is an oil refinery (or subclass thereof)
 * with optional country, operator, capacity, status. Limits to ~1000
 * to stay well below the 60-second query timeout.
 */
const SPARQL_QUERY = `
SELECT ?refinery ?refineryLabel ?countryCode ?operatorLabel ?ownerLabel
       ?capacity ?capacityUnit ?statusLabel ?inception
WHERE {
  ?refinery wdt:P31/wdt:P279* wd:Q235365 .
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
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en" . }
}
LIMIT 1000
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
};

async function fetchWikidata(): Promise<SparqlRow[]> {
  const url = `${SPARQL_ENDPOINT}?query=${encodeURIComponent(SPARQL_QUERY)}`;
  const res = await fetch(url, {
    headers: {
      Accept: 'application/sparql-results+json',
      'User-Agent': 'procur-research/1.0 (contact: cole@vectortradecapital.com)',
    },
  });
  if (!res.ok) {
    throw new Error(`Wikidata SPARQL ${res.status}: ${await res.text()}`);
  }
  const json = (await res.json()) as { results: { bindings: SparqlRow[] } };
  return json.results.bindings;
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
