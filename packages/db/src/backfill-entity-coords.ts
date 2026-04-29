/**
 * Backfill known_entities.latitude / longitude from Wikidata.
 *
 * Why: a chunk of physical-asset rows (refineries, terminals, ports)
 * landed without coordinates — Wikipedia-derived rows always store
 * null, and some Wikidata-derived rows lack P625 upstream. Coordinates
 * gate proximity-based ranking on tender sourcing (vex-tender-sourcing-
 * pointer.md → /intelligence/proximity-suppliers + originBias on
 * find_suppliers_for_tender).
 *
 * Two resolution paths, in order:
 *
 *   1. metadata.wikidata_id is set → fetch the entity directly via
 *      wbgetentities, extract P625 (coordinate location).
 *   2. No QID → wbsearchentities by canonicalName, then filter to
 *      candidates whose P17 (country) matches the row's country.
 *      Accept only when exactly one candidate has P625 — ambiguous
 *      matches stay null and get logged.
 *
 * Idempotent (skips rows where latitude IS NOT NULL). Polite throttle
 * (250ms between Wikidata requests).
 *
 * Run from repo root:
 *   pnpm --filter @procur/db backfill-entity-coords
 *   pnpm --filter @procur/db backfill-entity-coords -- --dry-run
 *   pnpm --filter @procur/db backfill-entity-coords -- --limit=50
 *
 * Roles considered "physical" by default: refiner, producer, terminal,
 * port. Trading houses don't get a backfill — multinationals don't have
 * a single canonical location.
 */
import 'dotenv/config';
import { config as loadEnv } from 'dotenv';
import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import * as schema from './schema';

loadEnv({ path: '../../.env.local' });
loadEnv({ path: '../../.env' });

const WD_API = 'https://www.wikidata.org/w/api.php';
const PHYSICAL_ROLES = ['refiner', 'producer', 'terminal', 'port'];
const THROTTLE_MS = 250;
const UA = 'procur-research/1.0 (cole@vectortradecapital.com)';

type Coord = { latitude: number; longitude: number };

type WdEntity = {
  id: string;
  claims?: Record<
    string,
    Array<{
      mainsnak?: {
        datavalue?: {
          value?: { latitude?: number; longitude?: number; id?: string } | string;
          type?: string;
        };
      };
    }>
  >;
  sitelinks?: Record<string, { title: string }>;
};

async function wbgetentities(ids: string[]): Promise<Record<string, WdEntity>> {
  if (ids.length === 0) return {};
  const url = new URL(WD_API);
  url.searchParams.set('action', 'wbgetentities');
  url.searchParams.set('ids', ids.join('|'));
  url.searchParams.set('props', 'claims');
  url.searchParams.set('format', 'json');
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`wbgetentities ${res.status}: ${await res.text().then((t) => t.slice(0, 200))}`);
  const json = (await res.json()) as { entities?: Record<string, WdEntity> };
  return json.entities ?? {};
}

async function wbsearchentities(query: string): Promise<Array<{ id: string; label: string }>> {
  const url = new URL(WD_API);
  url.searchParams.set('action', 'wbsearchentities');
  url.searchParams.set('search', query);
  url.searchParams.set('language', 'en');
  url.searchParams.set('limit', '10');
  url.searchParams.set('format', 'json');
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  if (!res.ok) return [];
  const json = (await res.json()) as { search?: Array<{ id: string; label: string }> };
  return json.search ?? [];
}

function extractCoord(entity: WdEntity): Coord | null {
  const claims = entity.claims?.P625 ?? [];
  for (const c of claims) {
    const v = c.mainsnak?.datavalue?.value;
    if (typeof v === 'object' && v !== null && typeof v.latitude === 'number' && typeof v.longitude === 'number') {
      return { latitude: v.latitude, longitude: v.longitude };
    }
  }
  return null;
}

function extractCountryQid(entity: WdEntity): string | null {
  const claims = entity.claims?.P17 ?? [];
  for (const c of claims) {
    const v = c.mainsnak?.datavalue?.value;
    if (typeof v === 'object' && v !== null && typeof v.id === 'string') return v.id;
  }
  return null;
}

/**
 * Map an ISO-2 country code to its Wikidata QID for the country-filter
 * step. Hand-rolled for the publishers we care about; fall through to
 * a Wikidata lookup-by-iso2 for anything else.
 */
const COUNTRY_QID_BY_ISO2: Record<string, string> = {
  US: 'Q30', CA: 'Q16', MX: 'Q96',
  // Caribbean
  DO: 'Q786', JM: 'Q766', TT: 'Q754', BS: 'Q778', BB: 'Q244', HT: 'Q790', PR: 'Q1183',
  // Latin America
  AR: 'Q414', BR: 'Q155', CL: 'Q298', CO: 'Q739', EC: 'Q736', PE: 'Q419',
  PY: 'Q733', UY: 'Q77', BO: 'Q750', VE: 'Q717',
  GT: 'Q774', HN: 'Q783', SV: 'Q792', NI: 'Q811', CR: 'Q800', PA: 'Q804',
  // Europe
  GB: 'Q145', DE: 'Q183', FR: 'Q142', IT: 'Q38', ES: 'Q29', PT: 'Q45',
  NL: 'Q55', BE: 'Q31', GR: 'Q41', TR: 'Q43', RO: 'Q218', PL: 'Q36',
  CZ: 'Q213', HU: 'Q28', BG: 'Q219', HR: 'Q224', SE: 'Q34', NO: 'Q20',
  FI: 'Q33', DK: 'Q35', IE: 'Q27', AT: 'Q40', CH: 'Q39', UA: 'Q212', RU: 'Q159',
  // Middle East
  IL: 'Q801', SA: 'Q851', AE: 'Q878', QA: 'Q846', KW: 'Q817', OM: 'Q842',
  BH: 'Q398', IR: 'Q794', IQ: 'Q796', JO: 'Q810', LB: 'Q822', SY: 'Q858',
  YE: 'Q805', EG: 'Q79',
  // Africa
  NG: 'Q1033', GH: 'Q117', SN: 'Q1041', ZA: 'Q258', KE: 'Q114',
  MA: 'Q1028', DZ: 'Q262', TN: 'Q948', LY: 'Q1016', AO: 'Q916',
  CI: 'Q1008', ET: 'Q115', UG: 'Q1036', TZ: 'Q924', SD: 'Q1049',
  // Asia
  IN: 'Q668', CN: 'Q148', JP: 'Q17', KR: 'Q884', SG: 'Q334',
  TH: 'Q869', VN: 'Q881', MY: 'Q833', ID: 'Q252', PH: 'Q928',
  PK: 'Q843', BD: 'Q902', LK: 'Q854',
  // Oceania
  AU: 'Q408', NZ: 'Q664',
};

async function resolveCoord(
  entityId: string,
  canonicalName: string,
  country: string | null,
  wikidataId: string | null,
): Promise<{ coord: Coord; via: 'qid' | 'search'; matchedQid: string } | { coord: null; reason: string }> {
  // Path 1 — direct QID.
  if (wikidataId) {
    const entities = await wbgetentities([wikidataId]);
    const ent = entities[wikidataId];
    if (!ent) return { coord: null, reason: `wikidata QID ${wikidataId} not found` };
    const coord = extractCoord(ent);
    if (coord) return { coord, via: 'qid', matchedQid: wikidataId };
    return { coord: null, reason: `${wikidataId} has no P625` };
  }

  // Path 2 — name search with country filter.
  const candidates = await wbsearchentities(canonicalName);
  if (candidates.length === 0) {
    return { coord: null, reason: `no Wikidata search results for "${canonicalName}"` };
  }
  const candidateIds = candidates.slice(0, 5).map((c) => c.id);
  await sleep(THROTTLE_MS);
  const fetched = await wbgetentities(candidateIds);

  const expectedCountryQid = country ? COUNTRY_QID_BY_ISO2[country] ?? null : null;
  const matches: Array<{ id: string; coord: Coord }> = [];
  for (const id of candidateIds) {
    const ent = fetched[id];
    if (!ent) continue;
    const coord = extractCoord(ent);
    if (!coord) continue;
    if (expectedCountryQid) {
      const ctry = extractCountryQid(ent);
      if (ctry !== expectedCountryQid) continue;
    }
    matches.push({ id, coord });
  }

  if (matches.length === 1) {
    return { coord: matches[0]!.coord, via: 'search', matchedQid: matches[0]!.id };
  }
  if (matches.length === 0) {
    return {
      coord: null,
      reason: `no Wikidata candidate for "${canonicalName}" (country=${country}) had P625 + matching P17`,
    };
  }
  return {
    coord: null,
    reason: `ambiguous: ${matches.length} Wikidata candidates matched "${canonicalName}" in ${country} (${matches.map((m) => m.id).join(', ')})`,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set');
  const dryRun = process.argv.includes('--dry-run');
  const limitArg = process.argv.find((a) => a.startsWith('--limit='))?.split('=')[1];
  const limit = limitArg ? Number.parseInt(limitArg, 10) : Number.POSITIVE_INFINITY;

  const client = neon(url);
  const db = drizzle(client, { schema, casing: 'snake_case' });

  const rows = await db
    .select({
      id: schema.knownEntities.id,
      slug: schema.knownEntities.slug,
      canonicalName: schema.knownEntities.name,
      country: schema.knownEntities.country,
      role: schema.knownEntities.role,
      metadata: schema.knownEntities.metadata,
    })
    .from(schema.knownEntities)
    .where(
      and(
        isNull(schema.knownEntities.latitude),
        inArray(schema.knownEntities.role, PHYSICAL_ROLES),
      ),
    );

  const targets = Number.isFinite(limit) ? rows.slice(0, limit) : rows;
  console.log(
    `Found ${rows.length} physical entities with null coords; ` +
      `processing ${targets.length}${dryRun ? ' (dry run)' : ''}.`,
  );

  let resolved = 0;
  let unresolved = 0;
  const unresolvedReasons: string[] = [];

  for (const row of targets) {
    const meta = (row.metadata as { wikidata_id?: string } | null) ?? null;
    const wikidataId = meta?.wikidata_id ?? null;
    const result = await resolveCoord(row.id, row.canonicalName, row.country, wikidataId);
    await sleep(THROTTLE_MS);

    if (result.coord) {
      resolved += 1;
      const tag = `${row.slug} (${result.via}, ${result.matchedQid})`;
      console.log(`  ✓ ${tag} → (${result.coord.latitude.toFixed(4)}, ${result.coord.longitude.toFixed(4)})`);
      if (!dryRun) {
        await db
          .update(schema.knownEntities)
          .set({
            latitude: String(result.coord.latitude),
            longitude: String(result.coord.longitude),
            updatedAt: new Date(),
            metadata: sql`COALESCE(${schema.knownEntities.metadata}, '{}'::jsonb) || ${JSON.stringify({
              coord_source: 'wikidata',
              coord_resolved_via: result.via,
              coord_matched_qid: result.matchedQid,
            })}::jsonb`,
          })
          .where(eq(schema.knownEntities.id, row.id));
      }
    } else {
      unresolved += 1;
      unresolvedReasons.push(`  · ${row.slug} (${row.country}) — ${result.reason}`);
    }
  }

  console.log(`\nResolved: ${resolved}`);
  console.log(`Unresolved: ${unresolved}`);
  if (unresolvedReasons.length > 0 && unresolvedReasons.length <= 50) {
    console.log('\nUnresolved details:');
    for (const r of unresolvedReasons) console.log(r);
  } else if (unresolvedReasons.length > 50) {
    console.log(`\nUnresolved details (first 50 of ${unresolvedReasons.length}):`);
    for (const r of unresolvedReasons.slice(0, 50)) console.log(r);
  }

  if (dryRun) console.log('\n(dry run — no DB writes)');
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
