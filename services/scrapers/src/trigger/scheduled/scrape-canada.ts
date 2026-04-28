import { schedules, task, tasks } from '@trigger.dev/sdk';
import { CanadaBuysScraper } from '../../jurisdictions/canada-buys/scraper';

/**
 * CanadaBuys — Canadian federal procurement, filtered to VTC's commodity
 * GSIN families (food 89xx, fuel 91xx, vehicles 23xx, minerals 96xx).
 *
 * Two entry points:
 *
 *   `scrape-canada` (scheduled, every 6h)
 *     CSV is updated daily, so 6h is overkill from a freshness angle but
 *     mirrors the SAM cadence and keeps the dashboard predictable. CSV
 *     is ~5MB so the bandwidth cost per run is trivial.
 *
 *   `scrape-canada-backfill` (regular task, manual trigger)
 *     Accepts a custom JSON payload — useful for widening filters or
 *     pointing at the full feed:
 *
 *       { "gsinPrefixes": [] }                   // ingest everything (huge!)
 *       { "gsinPrefixes": ["89", "91"] }         // food + fuel only
 *       { "csvUrl": "https://.../different.csv" } // alt feed (annual archive)
 *
 * No auth — public open data. CanadaBuys publishes the open-tender feed
 * as a daily CSV; no API key needed.
 */

type CanadaBackfillPayload = {
  csvUrl?: string;
  /**
   * When true, ingest every Goods row regardless of VTC keyword filter.
   * Useful for full-catalog backfills (~250 goods rows per refresh).
   */
  allGoods?: boolean;
};

async function runCanada(opts: CanadaBackfillPayload, triggerRunId: string) {
  const scraper = new CanadaBuysScraper(opts);
  const result = await scraper.run({ triggerRunId });

  if (result.insertedIds.length > 0) {
    await tasks.batchTrigger(
      'opportunity.enrich',
      result.insertedIds.map((opportunityId: string) => ({
        payload: { opportunityId },
      })),
    );
  }

  return result;
}

export const scrapeCanada = schedules.task({
  id: 'scrape-canada',
  cron: '0 */6 * * *',
  maxDuration: 1800,
  run: async (_payload, { ctx }) => runCanada({}, ctx.run.id),
});

export const scrapeCanadaBackfill = task({
  id: 'scrape-canada-backfill',
  maxDuration: 3600,
  run: async (payload: CanadaBackfillPayload, { ctx }) =>
    runCanada(payload ?? {}, ctx.run.id),
});
