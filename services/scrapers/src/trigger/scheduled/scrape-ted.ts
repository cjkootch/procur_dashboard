import { schedules, task, tasks } from '@trigger.dev/sdk';
import { TedScraper } from '../../jurisdictions/ted/scraper';

/**
 * TED — EU Tenders Electronic Daily, filtered to VTC's commodity CPV
 * prefixes (15* food, 09* fuel, 34* vehicles, 14* minerals).
 *
 * Two entry points (same pattern as scrape-sam):
 *
 *   `scrape-ted` (scheduled, every 4h)
 *     Default scheduled crawl. 7-day window (TED publishes daily so 7d
 *     is enough; older notices get reaped via the AI pipeline once
 *     their deadlines pass). 4h cadence keeps EU-business-day
 *     notices visible quickly without redundant calls overnight.
 *
 *   `scrape-ted-backfill` (regular task, manual trigger)
 *     Custom payload for ad-hoc backfills:
 *
 *       { "postedWithinDays": 30 }                    // wider window
 *       { "cpvPrefixes": ["15", "09"] }               // food + fuel only
 *       { "cpvPrefixes": [] }                         // ingest everything
 *       { "maxPages": 100 }                           // remove the 50-page cap
 *
 * No auth — TED's v3 search API is public (no API key required).
 */

type TedBackfillPayload = {
  postedWithinDays?: number;
  cpvPrefixes?: string[];
  maxPages?: number;
};

async function runTed(opts: TedBackfillPayload, triggerRunId: string) {
  const scraper = new TedScraper(opts);
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

export const scrapeTed = schedules.task({
  id: 'scrape-ted',
  cron: '15 */4 * * *',
  maxDuration: 1800,
  run: async (_payload, { ctx }) => runTed({}, ctx.run.id),
});

export const scrapeTedBackfill = task({
  id: 'scrape-ted-backfill',
  maxDuration: 3600,
  run: async (payload: TedBackfillPayload, { ctx }) =>
    runTed(payload ?? {}, ctx.run.id),
});
