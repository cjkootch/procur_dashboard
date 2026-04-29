/**
 * SEC EDGAR daily ingest — distress-keyword hits in 10-K / 10-Q / 8-K
 * filings from a watchlist of US-listed petroleum + metals companies.
 *
 * Flow:
 *   1. Pull the watchlist: known_entities rows where role IN
 *      ('producer', 'refiner', 'trader') AND country = 'US' AND
 *      metadata->>'sec_cik' IS NOT NULL.
 *   2. For each CIK, GET data.sec.gov/submissions/CIK{padded}.json.
 *      Filter to filings of forms (10-K, 10-Q, 8-K) submitted within
 *      the lookback window (default 2 days; covers the daily cron
 *      schedule + a weekend buffer).
 *   3. For each new filing, fetch the primary document and full-text
 *      search for distress / motivation keywords (offtake, force
 *      majeure, turnaround, asset sale, restructuring, capacity
 *      reduction, marketing agreement).
 *   4. For each hit, upsert one entity_news_events row with:
 *        - source = 'sec-edgar'
 *        - source_doc_id = accession_number (idempotency key)
 *        - event_type = 'sec_filing_<keyword>'
 *        - relevance_score = NULL (LLM scoring deferred to v2)
 *        - summary = "<keyword> mentioned in <form> filing — <240ch excerpt>"
 *
 * The CIK watchlist is intentionally seeded at the
 * known_entities.metadata level rather than embedded in this script —
 * keep the curated rolodex as the source of truth. A one-time seed
 * script (or analyst curation) populates metadata.sec_cik; this
 * worker simply iterates whatever's there. On a fresh DB the worker
 * logs "no watchlist" and exits cleanly.
 *
 * Auth: SEC's only requirement is a contact-email user-agent.
 * Rate limit: 10 req/sec hard cap. We throttle at 200ms between
 * requests for safety.
 *
 * Run from repo root:
 *   pnpm --filter @procur/db ingest-sec-edgar
 *   pnpm --filter @procur/db ingest-sec-edgar -- --days-back=7    # backfill
 *   pnpm --filter @procur/db ingest-sec-edgar -- --dry-run        # no writes
 */
import 'dotenv/config';
import { config as loadEnv } from 'dotenv';
import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import { sql } from 'drizzle-orm';
import * as schema from './schema';

loadEnv({ path: '../../.env.local' });
loadEnv({ path: '../../.env' });

const SEC_BASE = 'https://www.sec.gov';
const SEC_DATA = 'https://data.sec.gov';
const UA = 'procur-research/1.0 (cole@vectortradecapital.com)';
const FORM_TYPES = new Set(['10-K', '10-Q', '8-K', '6-K']);

/**
 * Distress / motivation keywords. Each maps to an event_type slug
 * stored on the row so downstream consumers can filter by the
 * specific signal class (e.g. "show me only force-majeure mentions").
 *
 * Keep this list intentionally short — false positives dilute the
 * relevance signal. The LLM extraction step in v2 will downgrade
 * routine-mention noise (e.g. "no force majeure events occurred").
 */
const KEYWORDS: Array<{ phrase: RegExp; eventType: string }> = [
  { phrase: /\boff\s*take\b/i, eventType: 'sec_filing_offtake_change' },
  { phrase: /\bmarketing agreement\b/i, eventType: 'sec_filing_marketing_agreement' },
  { phrase: /\bforce majeure\b/i, eventType: 'sec_filing_force_majeure' },
  { phrase: /\bturnaround\b/i, eventType: 'sec_filing_turnaround' },
  { phrase: /\bcapacity reduction\b/i, eventType: 'sec_filing_capacity_reduction' },
  { phrase: /\basset sale\b/i, eventType: 'sec_filing_asset_sale' },
  { phrase: /\brestructuring\b/i, eventType: 'sec_filing_restructuring' },
];

export type IngestSecEdgarResult = {
  daysBack: number;
  watchlistSize: number;
  filingsScanned: number;
  hitsInserted: number;
  hitsSkippedDuplicate: number;
  errors: string[];
};

type WatchlistRow = {
  knownEntityId: string;
  name: string;
  country: string;
  cik: string;
};

type SecSubmission = {
  cik: string;
  name: string;
  filings: {
    recent: {
      accessionNumber: string[];
      form: string[];
      filingDate: string[];
      primaryDocument: string[];
    };
  };
};

export async function ingestSecEdgar(opts: {
  daysBack?: number;
  dryRun?: boolean;
} = {}): Promise<IngestSecEdgarResult> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set');
  const daysBack = opts.daysBack ?? 2;
  const dryRun = opts.dryRun ?? false;

  const client = neon(url);
  const db = drizzle(client, { schema, casing: 'snake_case' });

  const watchlist = await loadWatchlist(db);
  console.log(
    `SEC EDGAR: ${watchlist.length} watchlist entities ` +
      `(known_entities with metadata.sec_cik set, role in producer|refiner|trader, country=US).`,
  );
  if (watchlist.length === 0) {
    console.log(
      'No watchlist. Seed metadata.sec_cik on relevant known_entities first ' +
        '(see ingest-sec-edgar.ts header for v2 plan to populate from SEC bulk file).',
    );
    return {
      daysBack,
      watchlistSize: 0,
      filingsScanned: 0,
      hitsInserted: 0,
      hitsSkippedDuplicate: 0,
      errors: [],
    };
  }

  const cutoffDate = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000);
  const cutoff = cutoffDate.toISOString().slice(0, 10);
  let filingsScanned = 0;
  let hitsInserted = 0;
  let hitsSkippedDuplicate = 0;
  const errors: string[] = [];

  for (const w of watchlist) {
    try {
      const submissions = await fetchSubmissions(w.cik);
      if (!submissions) {
        errors.push(`No submissions for CIK ${w.cik} (${w.name})`);
        await sleep(200);
        continue;
      }
      const recent = submissions.filings?.recent;
      if (!recent || recent.accessionNumber.length === 0) {
        await sleep(200);
        continue;
      }
      for (let i = 0; i < recent.accessionNumber.length; i += 1) {
        const filingDate = recent.filingDate[i];
        const form = recent.form[i];
        if (!filingDate || !form || filingDate < cutoff) continue;
        if (!FORM_TYPES.has(form)) continue;

        const accessionNumber = recent.accessionNumber[i]!;
        const primaryDoc = recent.primaryDocument[i] ?? '';
        filingsScanned += 1;

        const docText = await fetchFilingText(w.cik, accessionNumber, primaryDoc);
        await sleep(200);
        if (!docText) continue;

        const hits = scanForKeywords(docText);
        if (hits.length === 0) continue;

        for (const hit of hits) {
          const summary = synthesiseSummary(form, hit);
          if (dryRun) {
            console.log(
              `  [dry] ${w.name} ${form} ${filingDate} → ${hit.eventType}`,
            );
            continue;
          }
          const inserted = await upsertEvent(db, {
            knownEntityId: w.knownEntityId,
            sourceEntityName: w.name,
            sourceEntityCountry: w.country,
            eventType: hit.eventType,
            eventDate: filingDate,
            summary,
            sourceUrl: filingUrl(w.cik, accessionNumber, primaryDoc),
            sourceDocId: `${accessionNumber}:${hit.eventType}`,
            rawPayload: { form, accessionNumber, primaryDocument: primaryDoc, excerpt: hit.context },
          });
          if (inserted) {
            hitsInserted += 1;
            console.log(
              `  ✓ ${w.name} ${form} ${filingDate} → ${hit.eventType}`,
            );
          } else {
            hitsSkippedDuplicate += 1;
          }
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${w.name} (CIK ${w.cik}): ${msg}`);
    }
    await sleep(200);
  }

  return {
    daysBack,
    watchlistSize: watchlist.length,
    filingsScanned,
    hitsInserted,
    hitsSkippedDuplicate,
    errors,
  };
}

async function loadWatchlist(
  db: ReturnType<typeof drizzle<typeof schema>>,
): Promise<WatchlistRow[]> {
  const result = await db.execute(sql`
    SELECT id, name, country, metadata->>'sec_cik' AS cik
    FROM known_entities
    WHERE country = 'US'
      AND role IN ('producer', 'refiner', 'trader')
      AND metadata->>'sec_cik' IS NOT NULL
  `);
  return (result.rows as Array<Record<string, unknown>>).map((r) => ({
    knownEntityId: String(r.id),
    name: String(r.name),
    country: String(r.country),
    cik: String(r.cik).padStart(10, '0'),
  }));
}

async function fetchSubmissions(cik: string): Promise<SecSubmission | null> {
  const url = `${SEC_DATA}/submissions/CIK${cik}.json`;
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`SEC submissions ${res.status} for CIK ${cik}: ${(await res.text()).slice(0, 200)}`);
  }
  return (await res.json()) as SecSubmission;
}

async function fetchFilingText(
  cik: string,
  accessionNumber: string,
  primaryDocument: string,
): Promise<string | null> {
  if (!primaryDocument) return null;
  const accNoDashes = accessionNumber.replace(/-/g, '');
  const url = `${SEC_BASE}/Archives/edgar/data/${Number.parseInt(cik, 10)}/${accNoDashes}/${primaryDocument}`;
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html' } });
  if (!res.ok) return null;
  const html = await res.text();
  // Strip tags + collapse whitespace. Cap at 200KB to bound the
  // keyword scan; SEC primary documents are routinely 1-5MB but the
  // signal density doesn't scale linearly.
  const stripped = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return stripped.slice(0, 200_000);
}

function filingUrl(cik: string, accessionNumber: string, primaryDocument: string): string {
  const accNoDashes = accessionNumber.replace(/-/g, '');
  return `${SEC_BASE}/Archives/edgar/data/${Number.parseInt(cik, 10)}/${accNoDashes}/${primaryDocument}`;
}

function scanForKeywords(text: string): Array<{ eventType: string; context: string }> {
  const hits: Array<{ eventType: string; context: string }> = [];
  const seen = new Set<string>();
  for (const k of KEYWORDS) {
    const m = k.phrase.exec(text);
    if (m && m.index != null) {
      // Dedupe same-event-type hits in one filing (we surface the
      // first occurrence; subsequent are noise).
      if (seen.has(k.eventType)) continue;
      seen.add(k.eventType);
      const start = Math.max(0, m.index - 80);
      const end = Math.min(text.length, m.index + 160);
      hits.push({ eventType: k.eventType, context: text.slice(start, end).trim() });
    }
    // Reset lastIndex for global regex safety.
    k.phrase.lastIndex = 0;
  }
  return hits;
}

function synthesiseSummary(form: string, hit: { eventType: string; context: string }): string {
  const phrase = hit.eventType.replace(/^sec_filing_/, '').replace(/_/g, ' ');
  return `${phrase} mentioned in ${form} filing — ${hit.context}`.slice(0, 600);
}

async function upsertEvent(
  db: ReturnType<typeof drizzle<typeof schema>>,
  row: {
    knownEntityId: string | null;
    sourceEntityName: string;
    sourceEntityCountry: string | null;
    eventType: string;
    eventDate: string;
    summary: string;
    sourceUrl: string;
    sourceDocId: string;
    rawPayload: Record<string, unknown>;
  },
): Promise<boolean> {
  // ON CONFLICT (source, source_doc_id) DO NOTHING — the unique index
  // enforces idempotency. Returns whether a row was actually inserted.
  const result = await db.execute(sql`
    INSERT INTO entity_news_events (
      known_entity_id, source_entity_name, source_entity_country,
      event_type, event_date, summary, raw_payload, source, source_url, source_doc_id
    )
    VALUES (
      ${row.knownEntityId}::uuid,
      ${row.sourceEntityName},
      ${row.sourceEntityCountry},
      ${row.eventType},
      ${row.eventDate}::date,
      ${row.summary},
      ${JSON.stringify(row.rawPayload)}::jsonb,
      'sec-edgar',
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
  const result = await ingestSecEdgar({ daysBack, dryRun });
  console.log(
    `\nSEC EDGAR: scanned ${result.filingsScanned} filings across ${result.watchlistSize} ` +
      `watchlist entities (last ${result.daysBack} days).`,
  );
  console.log(`  inserted: ${result.hitsInserted}`);
  console.log(`  skipped (dup): ${result.hitsSkippedDuplicate}`);
  if (result.errors.length > 0) {
    console.log(`  errors: ${result.errors.length}`);
    for (const e of result.errors.slice(0, 10)) console.log(`    · ${e}`);
  }
  if (dryRun) console.log('(dry run — no DB writes)');
}

// `import.meta.url === ...` would gate this but tsx invokes the file
// directly; check argv[1] basename instead so callers that import the
// module don't trigger main().
if (process.argv[1] && process.argv[1].endsWith('ingest-sec-edgar.ts')) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
