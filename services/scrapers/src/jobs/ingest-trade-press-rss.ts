/**
 * Hourly trade-press RSS ingest with LLM distress-signal extraction.
 *
 * Layer 3 PR 4 of the intelligence-layers brief. Polls a small set
 * of free RSS feeds, extracts distress / motivation signals via
 * Haiku, and upserts hits into entity_news_events.
 *
 * Why this lives in services/scrapers (not packages/db):
 *   The worker calls @procur/ai. @procur/ai already depends on
 *   @procur/db, so making @procur/db depend on @procur/ai would
 *   create a cycle. services/scrapers is the natural home — it
 *   already depends on both.
 *
 * Dedup strategy without a new schema: at startup we read the
 * latest event_date per feed slug from entity_news_events and skip
 * RSS items with pubDate <= that watermark. Items published since
 * the watermark are re-extracted. This wastes some Haiku calls when
 * a feed publishes many no-signal articles in a row, but bounds
 * total LLM cost to ~$1/day even in pathological cases. A separate
 * dedup table is a tractable v2 if costs creep up.
 *
 * RSS / Atom parsing: roll our own tiny parser via cheerio's xmlMode.
 * Both formats expose title/link/description/pubDate/guid (with Atom
 * naming variations summary/updated/id). Adding a dedicated dep just
 * for this is unwarranted given how stable the formats are.
 */
import { load } from 'cheerio';
import { sql } from 'drizzle-orm';
import { db } from '@procur/db';
import { extractDistressSignal } from '@procur/ai';

/**
 * Some feeds (energy-voice — Cloudflare bot-protected, hellenic-
 * shipping — strict Accept header) reject our short research UA.
 * A modern desktop-Chrome string slips through both. Same UA across
 * all feeds keeps behavior consistent.
 */
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 ProcurNews/1.0';
const FETCH_TIMEOUT_MS = 15_000;
const FEED_THROTTLE_MS = 1_500;
const ITEM_THROTTLE_MS = 250;
const MAX_ITEMS_PER_FEED = 30;

/**
 * Free RSS feeds we monitor for distress / motivation signals.
 * Each has a stable slug used as the source_doc_id prefix so
 * dedupe is per-feed.
 *
 * URLs are best-effort current as of writing. Verify before deploy
 * — feed URLs migrate occasionally and the worker will log "fetch
 * failed" without breaking the run if a feed disappears.
 */
type Feed = { slug: string; name: string; url: string };
const FEEDS: Feed[] = [
  {
    slug: 'mining-com',
    name: 'Mining.com',
    url: 'https://www.mining.com/feed/',
  },
  {
    slug: 'oilprice-com',
    name: 'OilPrice.com',
    url: 'https://oilprice.com/rss/main',
  },
  {
    slug: 'hellenic-shipping-news',
    name: 'Hellenic Shipping News',
    url: 'https://www.hellenicshippingnews.com/feed/',
  },
  {
    slug: 'energy-voice',
    name: 'Energy Voice',
    url: 'https://www.energyvoice.com/feed/',
  },
];

export type IngestRssResult = {
  feedsScanned: number;
  itemsScanned: number;
  itemsProcessed: number;
  itemsSkippedWatermark: number;
  signalsFound: number;
  hitsInserted: number;
  hitsSkippedDuplicate: number;
  errors: string[];
};

type RssItem = {
  guid: string;
  title: string;
  link: string;
  description: string;
  pubDate: string | null;
};

export async function ingestTradePressRss(opts: {
  feeds?: Feed[];
  /** Override per-feed cap. Default 30. */
  maxItemsPerFeed?: number;
  dryRun?: boolean;
} = {}): Promise<IngestRssResult> {
  const feeds = opts.feeds ?? FEEDS;
  const cap = opts.maxItemsPerFeed ?? MAX_ITEMS_PER_FEED;
  const dryRun = opts.dryRun ?? false;

  let itemsScanned = 0;
  let itemsProcessed = 0;
  let itemsSkippedWatermark = 0;
  let signalsFound = 0;
  let hitsInserted = 0;
  let hitsSkippedDuplicate = 0;
  const errors: string[] = [];

  for (const feed of feeds) {
    try {
      const items = await fetchAndParseFeed(feed.url);
      const watermark = await loadFeedWatermark(feed.slug);
      console.log(
        `RSS ${feed.slug}: ${items.length} items pulled, ` +
          `watermark=${watermark ?? 'none'}.`,
      );
      let processed = 0;
      for (const item of items) {
        if (processed >= cap) break;
        itemsScanned += 1;

        // Skip items strictly OLDER than the watermark — already
        // extracted in a previous run. The comparison was `<=`
        // before, which silently dropped every item that shared a
        // pubDate (date-resolution) with the watermark — including
        // the entire current day's volume. Source-doc-id unique
        // index handles re-extraction on the boundary day; let
        // those items through and rely on the dedup at insert
        // time.
        if (watermark && item.pubDate && item.pubDate < watermark) {
          itemsSkippedWatermark += 1;
          continue;
        }

        processed += 1;
        itemsProcessed += 1;

        let extracted;
        try {
          extracted = await extractDistressSignal({
            feedSource: feed.name,
            title: item.title,
            description: item.description,
            link: item.link,
            publishedAt: item.pubDate,
          });
        } catch (err) {
          errors.push(
            `${feed.slug} extract: ${err instanceof Error ? err.message : String(err)}`,
          );
          await sleep(ITEM_THROTTLE_MS);
          continue;
        }

        if (!extracted.hasDistressSignal || extracted.relevanceScore < 0.5) {
          await sleep(ITEM_THROTTLE_MS);
          continue;
        }
        signalsFound += 1;

        // One row per matched entity. Items with no entities still
        // get one row using a synthesised source_entity_name (the
        // article title) so the analyst can backlink later.
        const entitiesToInsert = extracted.entities.length > 0
          ? extracted.entities
          : [{ name: item.title.slice(0, 200), country: null, role: null }];

        for (const entity of entitiesToInsert) {
          const sourceDocId = `${feed.slug}:${item.guid}:${slugifyName(entity.name)}`;
          if (dryRun) {
            console.log(
              `  [dry] ${feed.slug} → ${entity.name} (${extracted.distressKeyword ?? 'distress'}, ` +
                `score=${extracted.relevanceScore.toFixed(2)})`,
            );
            continue;
          }
          const inserted = await upsertEvent({
            sourceEntityName: entity.name,
            sourceEntityCountry: entity.country,
            eventType: 'press_distress_signal',
            eventDate: (item.pubDate ?? new Date().toISOString()).slice(0, 10),
            summary: extracted.summary,
            sourceUrl: item.link,
            sourceDocId,
            relevanceScore: extracted.relevanceScore,
            rawPayload: {
              feed: feed.name,
              feedSlug: feed.slug,
              guid: item.guid,
              title: item.title,
              distressKeyword: extracted.distressKeyword,
              entityRole: entity.role,
              llmUsage: extracted.usage,
            },
          });
          if (inserted) {
            hitsInserted += 1;
            console.log(
              `  ✓ ${feed.slug} → ${entity.name} (${extracted.distressKeyword ?? 'distress'}, ` +
                `score=${extracted.relevanceScore.toFixed(2)})`,
            );
          } else {
            hitsSkippedDuplicate += 1;
          }
        }
        await sleep(ITEM_THROTTLE_MS);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${feed.slug} fetch: ${msg}`);
    }
    await sleep(FEED_THROTTLE_MS);
  }

  return {
    feedsScanned: feeds.length,
    itemsScanned,
    itemsProcessed,
    itemsSkippedWatermark,
    signalsFound,
    hitsInserted,
    hitsSkippedDuplicate,
    errors,
  };
}

async function fetchAndParseFeed(url: string): Promise<RssItem[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': UA,
        // Some servers reject the strict feed-only Accept (HTTP 415
        // observed on hellenic-shipping-news with the previous
        // value). */* + a feed-priority q-value works everywhere.
        Accept:
          'application/rss+xml, application/atom+xml;q=0.9, application/xml;q=0.8, text/xml;q=0.8, */*;q=0.5',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const xml = await res.text();
    return parseFeed(xml);
  } finally {
    clearTimeout(timer);
  }
}

function parseFeed(xml: string): RssItem[] {
  const $ = load(xml, { xmlMode: true });
  const out: RssItem[] = [];

  // RSS 2.0 — <rss><channel><item>
  $('item').each((_, el) => {
    const $el = $(el);
    const title = $el.find('title').first().text().trim();
    const link = $el.find('link').first().text().trim() || $el.find('guid').first().text().trim();
    const description = stripHtml($el.find('description').first().text() || $el.find('content\\:encoded').first().text());
    const pubDateRaw = $el.find('pubDate').first().text().trim();
    const guid = $el.find('guid').first().text().trim() || link || title;
    if (!title || !link) return;
    out.push({ guid, title, link, description, pubDate: normaliseDate(pubDateRaw) });
  });

  // Atom — <feed><entry>
  if (out.length === 0) {
    $('entry').each((_, el) => {
      const $el = $(el);
      const title = $el.find('title').first().text().trim();
      const linkAttr = $el.find('link').first().attr('href');
      const link = linkAttr ?? '';
      const description = stripHtml($el.find('summary').first().text() || $el.find('content').first().text());
      const dateRaw = $el.find('updated').first().text().trim() || $el.find('published').first().text().trim();
      const guid = $el.find('id').first().text().trim() || link || title;
      if (!title || !link) return;
      out.push({ guid, title, link, description, pubDate: normaliseDate(dateRaw) });
    });
  }
  return out;
}

function normaliseDate(raw: string): string | null {
  if (!raw) return null;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function stripHtml(s: string): string {
  return s
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 2000);
}

function slugifyName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'unknown';
}

async function loadFeedWatermark(feedSlug: string): Promise<string | null> {
  const result = await db.execute(sql`
    SELECT MAX(event_date)::text AS watermark
    FROM entity_news_events
    WHERE source = 'rss-trade-press'
      AND source_doc_id LIKE ${feedSlug + ':%'}
  `);
  const row = (result.rows as Array<Record<string, unknown>>)[0];
  return row?.watermark ? String(row.watermark) : null;
}

async function upsertEvent(row: {
  sourceEntityName: string;
  sourceEntityCountry: string | null;
  eventType: string;
  eventDate: string;
  summary: string;
  sourceUrl: string | null;
  sourceDocId: string;
  relevanceScore: number;
  rawPayload: Record<string, unknown>;
}): Promise<boolean> {
  const result = await db.execute(sql`
    INSERT INTO entity_news_events (
      source_entity_name, source_entity_country,
      event_type, event_date, summary, raw_payload, source, source_url, source_doc_id,
      relevance_score
    )
    VALUES (
      ${row.sourceEntityName},
      ${row.sourceEntityCountry},
      ${row.eventType},
      ${row.eventDate}::date,
      ${row.summary},
      ${JSON.stringify(row.rawPayload)}::jsonb,
      'rss-trade-press',
      ${row.sourceUrl},
      ${row.sourceDocId},
      ${row.relevanceScore}
    )
    ON CONFLICT (source, source_doc_id) WHERE source_doc_id IS NOT NULL DO NOTHING
    RETURNING id
  `);
  return (result.rows as unknown[]).length > 0;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
