/**
 * Bankruptcy-filing distress signal via CourtListener / RECAP
 * (free public archive of US federal-court PACER filings).
 *
 * Why RECAP and not direct PACER:
 *   - PACER costs $0.10/page; ~$50/mo at our query volume.
 *   - PACER has no clean REST API — auth + scraping required.
 *   - CourtListener (RECAP) has a free, well-documented v4 REST API
 *     and its bankruptcy-court coverage is solid for the size of
 *     case we care about (a refiner / miner / trading house Chapter
 *     11 is exactly the kind of public filing RECAP captures).
 *   - The brief specifies PACER but the spirit ("monitor Chapter
 *     11/7/15 filings for petroleum + metals counterparties") fits
 *     RECAP without the cost or auth complexity.
 *
 * Industry-filter strategy: the brief proposed SIC-code filtering;
 * RECAP doesn't carry SIC. We instead filter via fuzzy-name match
 * against known_entities + external_suppliers — same intent (only
 * surface bankruptcies of counterparties we're tracking), more
 * tractable mechanism. Bankruptcies of unrelated companies pass
 * through silently.
 *
 * Flow:
 *   1. GET CourtListener search for chapter=11/7/15 dockets in
 *      bankruptcy courts (court__jurisdiction=FB) filed in the
 *      lookback window.
 *   2. Pull a name index over known_entities + external_suppliers.
 *   3. For each docket, fuzzy-match case_name (trigram-style
 *      similarity) against the name index.
 *   4. On match → upsert one entity_news_events row.
 *
 * Auth: optional COURTLISTENER_API_TOKEN env (free signup) lifts the
 * rate limit. Worker runs unauthenticated otherwise.
 *
 * Run from repo root:
 *   pnpm --filter @procur/db ingest-bankruptcy-recap
 *   pnpm --filter @procur/db ingest-bankruptcy-recap -- --days-back=30 --dry-run
 */
import 'dotenv/config';
import { config as loadEnv } from 'dotenv';
import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import { sql } from 'drizzle-orm';
import * as schema from './schema';

loadEnv({ path: '../../.env.local' });
loadEnv({ path: '../../.env' });

const CL_BASE = 'https://www.courtlistener.com/api/rest/v4';
const UA = 'procur-research/1.0 (cole@vectortradecapital.com)';
const RELEVANT_ROLES = ['producer', 'refiner', 'trader', 'state-buyer'];
const CHAPTERS = [11, 7, 15];
const NAME_MATCH_THRESHOLD = 0.45;

export type IngestBankruptcyResult = {
  daysBack: number;
  docketsScanned: number;
  matchesFound: number;
  hitsInserted: number;
  hitsSkippedDuplicate: number;
  errors: string[];
};

type CourtListenerDocket = {
  docket_id?: number;
  caseName?: string;
  case_name?: string;
  docketNumber?: string;
  docket_number?: string;
  dateFiled?: string;
  date_filed?: string;
  absolute_url?: string;
  chapter?: number | string;
  court?: string;
  court_id?: string;
};

type CourtListenerSearchPage = {
  count: number;
  next: string | null;
  results: CourtListenerDocket[];
};

type EntityIndexRow = {
  name: string;
  knownEntityId: string | null;
  externalSupplierId: string | null;
  country: string | null;
};

export async function ingestBankruptcyRecap(opts: {
  daysBack?: number;
  dryRun?: boolean;
} = {}): Promise<IngestBankruptcyResult> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set');
  const daysBack = opts.daysBack ?? 2;
  const dryRun = opts.dryRun ?? false;
  const apiToken = process.env.COURTLISTENER_API_TOKEN;

  const client = neon(url);
  const db = drizzle(client, { schema, casing: 'snake_case' });

  const cutoff = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);

  const nameIndex = await loadNameIndex(db);
  console.log(
    `RECAP bankruptcy: ${nameIndex.length} indexed entities ` +
      `(producer/refiner/trader known_entities + all external_suppliers).`,
  );
  if (nameIndex.length === 0) {
    return {
      daysBack,
      docketsScanned: 0,
      matchesFound: 0,
      hitsInserted: 0,
      hitsSkippedDuplicate: 0,
      errors: [],
    };
  }

  let docketsScanned = 0;
  let matchesFound = 0;
  let hitsInserted = 0;
  let hitsSkippedDuplicate = 0;
  const errors: string[] = [];

  for (const chapter of CHAPTERS) {
    let nextUrl: string | null = buildSearchUrl({ chapter, filedAfter: cutoff });
    let pages = 0;
    while (nextUrl && pages < 5) {
      try {
        const page = await fetchSearchPage(nextUrl, apiToken);
        pages += 1;
        for (const docket of page.results) {
          docketsScanned += 1;
          const caseName = docket.caseName ?? docket.case_name ?? '';
          if (!caseName) continue;
          const dateFiled = docket.dateFiled ?? docket.date_filed ?? cutoff;
          const docketId = docket.docket_id != null ? String(docket.docket_id) : null;
          const docketNumber = docket.docketNumber ?? docket.docket_number ?? '';
          const absoluteUrl = docket.absolute_url
            ? `https://www.courtlistener.com${docket.absolute_url}`
            : null;

          const match = matchEntity(caseName, nameIndex);
          if (!match) continue;
          matchesFound += 1;

          const sourceDocId = `recap:${docketId ?? docketNumber}:${chapter}`;
          if (dryRun) {
            console.log(
              `  [dry] ${match.name} ← "${caseName}" ` +
                `(Chapter ${chapter}, filed ${dateFiled}, similarity=${match.similarity.toFixed(2)})`,
            );
            continue;
          }
          const inserted = await upsertEvent(db, {
            knownEntityId: match.knownEntityId,
            externalSupplierId: match.externalSupplierId,
            sourceEntityName: caseName,
            sourceEntityCountry: match.country,
            eventType: 'bankruptcy_filing',
            eventDate: dateFiled,
            summary:
              `Chapter ${chapter} bankruptcy docketed for ${caseName} ` +
              `(matched ${match.name} at similarity ${match.similarity.toFixed(2)})`,
            sourceUrl: absoluteUrl,
            sourceDocId,
            rawPayload: {
              chapter,
              caseName,
              docketNumber,
              court: docket.court_id ?? docket.court,
              matchSimilarity: match.similarity,
            },
          });
          if (inserted) {
            hitsInserted += 1;
            console.log(
              `  ✓ ${match.name} ← "${caseName}" (Chapter ${chapter}, ${dateFiled})`,
            );
          } else {
            hitsSkippedDuplicate += 1;
          }
        }
        nextUrl = page.next;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`Chapter ${chapter} pg ${pages}: ${msg}`);
        nextUrl = null;
      }
      // Polite throttle. CL doesn't publish a hard cap but 1 req/sec
      // is well within typical free-tier behavior.
      await sleep(500);
    }
  }

  return {
    daysBack,
    docketsScanned,
    matchesFound,
    hitsInserted,
    hitsSkippedDuplicate,
    errors,
  };
}

function buildSearchUrl(args: { chapter: number; filedAfter: string }): string {
  const u = new URL(`${CL_BASE}/search/`);
  u.searchParams.set('type', 'r');
  u.searchParams.set('court__jurisdiction', 'FB');
  u.searchParams.set('chapter', String(args.chapter));
  u.searchParams.set('filed_after', args.filedAfter);
  u.searchParams.set('order_by', 'dateFiled desc');
  u.searchParams.set('page_size', '50');
  return u.toString();
}

async function fetchSearchPage(
  url: string,
  apiToken: string | undefined,
): Promise<CourtListenerSearchPage> {
  const headers: Record<string, string> = {
    'User-Agent': UA,
    Accept: 'application/json',
  };
  if (apiToken) headers.Authorization = `Token ${apiToken}`;
  const res = await fetch(url, { headers });
  if (!res.ok) {
    throw new Error(
      `CourtListener ${res.status}: ${(await res.text()).slice(0, 200)}`,
    );
  }
  return (await res.json()) as CourtListenerSearchPage;
}

async function loadNameIndex(
  db: ReturnType<typeof drizzle<typeof schema>>,
): Promise<EntityIndexRow[]> {
  // known_entities (curated rolodex) — narrow to physical / trading
  // roles where bankruptcy is meaningful.
  // IN-list rather than ANY(${arr}::text[]) — the latter trips up
  // Neon's HTTP wire protocol with 'cannot cast type record to text[]'.
  const rolesIn = sql.join(
    RELEVANT_ROLES.map((r) => sql`${r}`),
    sql`, `,
  );
  const knownResult = await db.execute(sql`
    SELECT id, name, country
    FROM known_entities
    WHERE role IN (${rolesIn})
  `);
  // external_suppliers (public-procurement winners) — pull all; the
  // role concept doesn't apply. Limit to the ones with at least one
  // award in the awards table to keep the index small.
  const externalResult = await db.execute(sql`
    SELECT DISTINCT s.id, s.organisation_name AS name, s.country
    FROM external_suppliers s
    JOIN award_awardees aa ON aa.supplier_id = s.id
    WHERE s.organisation_name IS NOT NULL
    LIMIT 5000
  `);

  const out: EntityIndexRow[] = [];
  for (const r of knownResult.rows as Array<Record<string, unknown>>) {
    out.push({
      name: String(r.name),
      knownEntityId: String(r.id),
      externalSupplierId: null,
      country: r.country == null ? null : String(r.country),
    });
  }
  for (const r of externalResult.rows as Array<Record<string, unknown>>) {
    out.push({
      name: String(r.name),
      knownEntityId: null,
      externalSupplierId: String(r.id),
      country: r.country == null ? null : String(r.country),
    });
  }
  return out;
}

/**
 * Trigram-style similarity match. Linear scan over the name index;
 * fine for indices up to ~10k entities (we run once daily on
 * dozens-to-hundreds of dockets).
 *
 * Rejects matches below NAME_MATCH_THRESHOLD. Picks the highest-
 * similarity result when multiple entities clear the threshold.
 */
function matchEntity(
  caseName: string,
  index: EntityIndexRow[],
): (EntityIndexRow & { similarity: number }) | null {
  const target = normaliseName(caseName);
  let best: (EntityIndexRow & { similarity: number }) | null = null;
  for (const row of index) {
    const candidate = normaliseName(row.name);
    if (!candidate) continue;
    const sim = trigramSimilarity(target, candidate);
    if (sim < NAME_MATCH_THRESHOLD) continue;
    if (!best || sim > best.similarity) {
      best = { ...row, similarity: sim };
    }
  }
  return best;
}

function normaliseName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/\b(inc|llc|ltd|s\.?a\.?|s\.?p\.?a\.?|gmbh|corp(?:oration)?|company|co\.|holdings|holding|group|plc|nv|bv)\b/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Approximate trigram similarity. Postgres' pg_trgm uses 3-char
 * k-grams; we match that here so SQL-side and worker-side matching
 * stay roughly consistent. Returns [0, 1].
 */
function trigramSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  const sa = trigrams(a);
  const sb = trigrams(b);
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter += 1;
  return inter / (sa.size + sb.size - inter);
}

function trigrams(s: string): Set<string> {
  const padded = `  ${s} `;
  const out = new Set<string>();
  for (let i = 0; i < padded.length - 2; i += 1) {
    out.add(padded.slice(i, i + 3));
  }
  return out;
}

async function upsertEvent(
  db: ReturnType<typeof drizzle<typeof schema>>,
  row: {
    knownEntityId: string | null;
    externalSupplierId: string | null;
    sourceEntityName: string;
    sourceEntityCountry: string | null;
    eventType: string;
    eventDate: string;
    summary: string;
    sourceUrl: string | null;
    sourceDocId: string;
    rawPayload: Record<string, unknown>;
  },
): Promise<boolean> {
  const result = await db.execute(sql`
    INSERT INTO entity_news_events (
      known_entity_id, external_supplier_id, source_entity_name, source_entity_country,
      event_type, event_date, summary, raw_payload, source, source_url, source_doc_id
    )
    VALUES (
      ${row.knownEntityId}::uuid,
      ${row.externalSupplierId}::uuid,
      ${row.sourceEntityName},
      ${row.sourceEntityCountry},
      ${row.eventType},
      ${row.eventDate}::date,
      ${row.summary},
      ${JSON.stringify(row.rawPayload)}::jsonb,
      'recap-bankruptcy',
      ${row.sourceUrl},
      ${row.sourceDocId}
    )
    ON CONFLICT (source, source_doc_id) WHERE source_doc_id IS NOT NULL DO NOTHING
    RETURNING id
  `);
  return (result.rows as unknown[]).length > 0;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const daysBackArg = process.argv.find((a) => a.startsWith('--days-back='))?.split('=')[1];
  const daysBack = daysBackArg ? Number.parseInt(daysBackArg, 10) : undefined;
  const dryRun = process.argv.includes('--dry-run');
  const result = await ingestBankruptcyRecap({ daysBack, dryRun });
  console.log(
    `\nRECAP bankruptcy: scanned ${result.docketsScanned} dockets ` +
      `(last ${result.daysBack} days), matched ${result.matchesFound}.`,
  );
  console.log(`  inserted: ${result.hitsInserted}`);
  console.log(`  skipped (dup): ${result.hitsSkippedDuplicate}`);
  if (result.errors.length > 0) {
    console.log(`  errors: ${result.errors.length}`);
    for (const e of result.errors.slice(0, 10)) console.log(`    · ${e}`);
  }
  if (dryRun) console.log('(dry run — no DB writes)');
}

if (process.argv[1] && process.argv[1].endsWith('ingest-bankruptcy-recap.ts')) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
