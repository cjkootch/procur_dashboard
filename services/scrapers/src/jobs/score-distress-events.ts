/**
 * Backfill `relevance_score` on entity_news_events rows that
 * landed with NULL — typically EDGAR + RECAP rows, since those
 * workers run keyword/match detection without LLM extraction
 * (the RSS worker is the one that already calls
 * extract-distress-signal at ingest time).
 *
 * Why two-pass instead of inline:
 *   - The EDGAR worker lives in @procur/db. @procur/ai depends on
 *     @procur/db (for shared schemas), so making @procur/db
 *     depend on @procur/ai creates a cycle. Moving the LLM call
 *     out to services/scrapers (which already depends on both)
 *     sidesteps the cycle.
 *   - Cost discipline: scoring runs on its own cadence, capped per
 *     run, so an EDGAR filings-blast or noisy RECAP day can't
 *     accidentally hammer the LLM bill.
 *
 * Strategy:
 *   1. Pull up to `limit` rows where relevance_score IS NULL
 *      AND source IN allowed sources, ordered oldest-first so we
 *      don't permanently starve early backlog.
 *   2. For each row, call extract-distress-signal with the row's
 *      summary + entity name + event type as the input bundle.
 *   3. Update the row with the returned score (Haiku per row;
 *      ~$0.001 each at the typical input/output sizes).
 *
 * The query layer already passes NULL through ("relevance_score IS
 * NULL OR >= 0.5") so unscored rows still show up in distress
 * results today — this just sharpens the signal.
 */
import { sql } from 'drizzle-orm';
import { db } from '@procur/db';
import { extractDistressSignal } from '@procur/ai';

const SCORABLE_SOURCES = ['sec-edgar', 'recap-bankruptcy'];
const ITEM_THROTTLE_MS = 200;

export type ScoreDistressEventsResult = {
  scanned: number;
  scored: number;
  skipped: number;
  errors: string[];
};

export async function scoreDistressEvents(opts: {
  limit?: number;
} = {}): Promise<ScoreDistressEventsResult> {
  const limit = Math.min(opts.limit ?? 100, 500);

  const rows = await db.execute(sql`
    SELECT id, source_entity_name, source_entity_country,
           event_type, event_date::text AS event_date,
           summary, source, source_url
    FROM entity_news_events
    WHERE relevance_score IS NULL
      AND source IN (${sql.join(
        SCORABLE_SOURCES.map((s) => sql`${s}`),
        sql`, `,
      )})
    ORDER BY ingested_at ASC
    LIMIT ${limit}
  `);

  const items = rows.rows as Array<Record<string, unknown>>;
  const errors: string[] = [];
  let scored = 0;
  let skipped = 0;

  for (const r of items) {
    const id = String(r.id);
    const summary = r.summary == null ? '' : String(r.summary);
    if (!summary.trim()) {
      skipped += 1;
      continue;
    }
    try {
      // Map our row into extract-distress-signal's expected shape.
      // Title: entity name + event-type label so the LLM has the
      // who + what at the head. Description: the existing summary.
      const eventLabel = String(r.event_type).replace(/_/g, ' ');
      const title = `${r.source_entity_name} — ${eventLabel}`;
      const link = r.source_url == null ? '' : String(r.source_url);
      const result = await extractDistressSignal({
        feedSource: String(r.source),
        title,
        description: summary,
        link,
        publishedAt: String(r.event_date),
      });
      // The task itself rates relevance regardless of whether it
      // also flags hasDistressSignal=true. We persist the raw
      // score so downstream readers can apply their own threshold.
      await db.execute(sql`
        UPDATE entity_news_events
        SET relevance_score = ${result.relevanceScore}::numeric,
            updated_at = NOW()
        WHERE id = ${id}::uuid
      `);
      scored += 1;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${id}: ${msg}`);
    }
    await sleep(ITEM_THROTTLE_MS);
  }

  return { scanned: items.length, scored, skipped, errors };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
