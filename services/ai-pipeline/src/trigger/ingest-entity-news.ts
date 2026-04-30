import { schedules } from '@trigger.dev/sdk/v3';
import { sql } from 'drizzle-orm';
import { db, entityNewsEvents, knownEntities } from '@procur/db';
import { log } from '@procur/utils/logger';
import { parseFeed } from '../lib/rss-parser';
import { tagNewsItem } from '../lib/news-tagger';

/**
 * Recurring ingest of energy / fuel-trading news from a curated set
 * of free RSS feeds. Each item passes through Haiku for entity
 * tagging + event classification, then lands in `entity_news_events`
 * deduped on (source, source_doc_id).
 *
 * The brief page reads from this table; the chat assistant reads
 * via lookup_entity_news + find_distressed_suppliers. Public-domain
 * data, no tenant scoping — every procur tenant sees the same
 * archive (same as known_entities).
 *
 * Schedule: every 4 hours. Energy news doesn't need sub-hour
 * latency, and 6 runs/day × ~20 items/feed × 7 feeds = ~840 Haiku
 * calls/day (~$0.10/day total).
 *
 * Failure mode: per-feed and per-item errors are isolated. A
 * single broken feed can't take the whole task down.
 */

type FeedSource = {
  url: string;
  /** Stable label persisted on entity_news_events.source. */
  label: string;
  /** Drop items older than this (days). RSS feeds vary wildly in
   *  history depth — Reuters carries weeks, OilPrice carries days. */
  maxAgeDays: number;
};

const FEED_SOURCES: FeedSource[] = [
  // OilPrice has a deep RSS feed covering crude / refined / geopolitics.
  { url: 'https://oilprice.com/rss/main', label: 'oilprice', maxAgeDays: 14 },
  // Hellenic Shipping News — heavy on tanker / freight market intel.
  {
    url: 'https://www.hellenicshippingnews.com/feed/',
    label: 'hellenic-shipping',
    maxAgeDays: 14,
  },
  // Energy Voice — UK-centric energy commercial news.
  { url: 'https://www.energyvoice.com/feed/', label: 'energy-voice', maxAgeDays: 14 },
  // Reuters Business / Energy — general but high signal on majors.
  {
    url: 'https://www.reutersagency.com/feed/?best-sectors=commodities-energy',
    label: 'reuters-energy',
    maxAgeDays: 14,
  },
];

export const ingestEntityNewsCron = schedules.task({
  id: 'news.ingest-entity-news',
  cron: '0 */4 * * *', // every 4h on the hour
  maxDuration: 1500, // 25min — generous; typical run is 1-2min
  run: async () => {
    const candidateEntityNames = await loadCandidateEntityNames();
    if (candidateEntityNames.length === 0) {
      log.warn(
        'news.ingest-entity-news: known_entities is empty; skipping (Haiku has nothing to tag against)',
      );
      return { feedsProcessed: 0, itemsIngested: 0 };
    }

    let feedsProcessed = 0;
    let itemsIngested = 0;
    let itemsSkippedNoise = 0;
    let itemsSkippedDup = 0;
    let itemsErrored = 0;

    for (const feed of FEED_SOURCES) {
      try {
        const xml = await fetchFeed(feed.url);
        const items = parseFeed(xml);
        feedsProcessed += 1;
        log.info(
          `news.ingest-entity-news: ${feed.label} returned ${items.length} items`,
        );

        const cutoff = Date.now() - feed.maxAgeDays * 24 * 60 * 60 * 1000;

        for (const item of items) {
          // Drop items older than the feed's max-age window.
          if (item.publishedAt) {
            const t = new Date(item.publishedAt).getTime();
            if (Number.isFinite(t) && t < cutoff) continue;
          }

          // Cheap pre-filter — if no candidate name appears in the
          // title or summary substring, skip Haiku entirely. Saves
          // ~70% of API calls on broad feeds (e.g. Reuters).
          const haystack = `${item.title} ${item.summary}`.toLowerCase();
          const anyMatch = candidateEntityNames.some((name) =>
            haystack.includes(name.toLowerCase()),
          );
          if (!anyMatch) {
            itemsSkippedNoise += 1;
            continue;
          }

          let tag;
          try {
            tag = await tagNewsItem({
              candidateEntityNames,
              title: item.title,
              summary: item.summary,
              source: feed.label,
            });
          } catch {
            itemsErrored += 1;
            continue;
          }
          if (!tag || tag.relevanceScore < 0.4) {
            itemsSkippedNoise += 1;
            continue;
          }

          // Resolve entity names → known_entities.id. Multiple
          // mentions: insert one row per mention so the entity-
          // detail panel can hit the right rows directly. Same
          // sourceDocId across rows is fine — the unique index is
          // on (source, source_doc_id) and we vary both rarely
          // enough that 1-row-per-entity-mention works in practice
          // (Haiku caps entityNames at 5).
          const sourceDocId =
            item.guid && item.guid.length > 0
              ? item.guid.slice(0, 500)
              : item.link.slice(0, 500);

          if (tag.entityNames.length === 0) {
            // Materially relevant but no resolved entity — skip.
            // Better than orphan rows with no entity link.
            itemsSkippedNoise += 1;
            continue;
          }

          const entityRows = await db.query.knownEntities.findMany({
            where: (t, { inArray }) => inArray(t.name, tag.entityNames),
            columns: { id: true, name: true, country: true },
          });
          const byName = new Map(entityRows.map((e) => [e.name, e]));

          for (let i = 0; i < tag.entityNames.length; i += 1) {
            const name = tag.entityNames[i]!;
            const entity = byName.get(name);
            if (!entity) continue;
            const eventDate =
              item.publishedAt && item.publishedAt.length > 0
                ? item.publishedAt.slice(0, 10)
                : new Date().toISOString().slice(0, 10);
            try {
              const inserted = await db
                .insert(entityNewsEvents)
                .values({
                  knownEntityId: entity.id,
                  sourceEntityName: name,
                  sourceEntityCountry: entity.country ?? null,
                  eventType: tag.eventType,
                  eventDate,
                  summary: tag.normalizedSummary,
                  source: feed.label,
                  sourceUrl: item.link || null,
                  // Append the entity index when the same article
                  // surfaces multiple entities — keeps the unique
                  // index from rejecting the second insert.
                  sourceDocId:
                    tag.entityNames.length > 1
                      ? `${sourceDocId}#${i}`
                      : sourceDocId,
                  relevanceScore: tag.relevanceScore.toFixed(2),
                  rawPayload: {
                    title: item.title,
                    summary: item.summary,
                    publishedAt: item.publishedAt,
                  },
                })
                .onConflictDoNothing({
                  target: [entityNewsEvents.source, entityNewsEvents.sourceDocId],
                })
                .returning({ id: entityNewsEvents.id });
              if (inserted.length > 0) {
                itemsIngested += 1;
              } else {
                itemsSkippedDup += 1;
              }
            } catch (err) {
              itemsErrored += 1;
              log.warn(`news.ingest-entity-news: insert failed`, {
                error: err instanceof Error ? err.message : String(err),
                source: feed.label,
              });
            }
          }
        }
      } catch (err) {
        log.error(`news.ingest-entity-news: feed ${feed.label} failed`, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return {
      feedsProcessed,
      itemsIngested,
      itemsSkippedNoise,
      itemsSkippedDup,
      itemsErrored,
    };
  },
});

/**
 * Load every known_entity name. The result feeds Haiku as the
 * candidate list — Haiku only emits names from this list, so we
 * need it complete (or at least the heads of the long tail).
 *
 * Caps at 1000 names. Beyond that we'd need a smarter pre-filter
 * (embeddings, country sharding, etc.) — defer until needed.
 */
async function loadCandidateEntityNames(): Promise<string[]> {
  const rows = await db
    .select({ name: knownEntities.name })
    .from(knownEntities)
    .orderBy(sql`coalesce(${knownEntities.metadata}->>'capacity_bpd', '0')::int desc`)
    .limit(1000);
  return rows.map((r) => r.name).filter((n) => n.length > 1);
}

async function fetchFeed(url: string): Promise<string> {
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const res = await fetch(url, {
      headers: {
        // Some feeds gate on a real-looking UA.
        'user-agent': 'ProcurNewsIngest/1.0 (+https://procur.app)',
        accept: 'application/rss+xml, application/atom+xml, text/xml, */*',
      },
      signal: ctrl.signal,
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} from ${url}`);
    }
    return res.text();
  } finally {
    clearTimeout(timeout);
  }
}
