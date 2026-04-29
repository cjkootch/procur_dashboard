import { schedules } from '@trigger.dev/sdk';
import { ingestTradePressRss } from '../../jobs/ingest-trade-press-rss';

/**
 * Hourly trade-press RSS ingest with LLM distress-signal extraction.
 *
 * Layer 3 PR 4 of the intelligence-layers brief. Polls 4 free RSS
 * feeds (Mining.com, OilPrice.com, Hellenic Shipping News, Energy
 * Voice), extracts distress signals via Haiku, and upserts hits
 * into entity_news_events with source='rss-trade-press'.
 *
 * Hourly cadence is well below feed publish rates so we catch new
 * articles within ~30min of publication on average. Per-feed
 * watermark dedup means hourly runs only re-extract articles
 * published since the last successful insert for that feed (cost
 * bounded; see jobs/ingest-trade-press-rss.ts for the rationale).
 *
 * Cost ceiling: ~$1/day at typical feed volumes (Haiku, short
 * input, ~50 articles/hour worst case).
 */
export const ingestTradePressRssScheduled = schedules.task({
  id: 'ingest-trade-press-rss',
  cron: '0 * * * *',
  maxDuration: 1500,
  run: async () => {
    const result = await ingestTradePressRss();
    console.log(
      `RSS trade-press: ${result.hitsInserted} new events from ` +
        `${result.signalsFound} signals across ${result.itemsProcessed} items ` +
        `(${result.itemsSkippedWatermark} skipped by watermark, ` +
        `${result.hitsSkippedDuplicate} dupes).`,
    );
    if (result.errors.length > 0) {
      console.log(`RSS errors: ${result.errors.length}`);
      for (const e of result.errors.slice(0, 5)) console.log(`  · ${e}`);
    }
    return result;
  },
});
