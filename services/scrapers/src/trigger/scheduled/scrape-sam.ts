import { schedules, task, tasks } from '@trigger.dev/sdk';
import { SamGovScraper } from '../../jurisdictions/sam-gov/scraper';

/**
 * SAM.gov — US federal procurement, filtered to VTC's commodity NAICS
 * (food, fuel, vehicles, minerals).
 *
 * Two entry points:
 *
 *   `scrape-sam` (scheduled, every 6h)
 *     The default scheduled crawl. Uses the scraper's default settings
 *     (60-day posted-within window, 3 pages × 1000 per NAICS). v3 SDK
 *     `schedules.task()` enforces a fixed payload shape (timestamp,
 *     lastTimestamp, timezone) — there's no way to inject custom
 *     overrides via the dashboard's Test UI for scheduled tasks.
 *
 *   `scrape-sam-backfill` (regular task, manual trigger)
 *     Accepts a custom JSON payload for ad-hoc backfills:
 *
 *       { "postedWithinDays": 90, "maxPagesPerNaics": 5 }
 *       { "naicsCodes": ["541512", "541519"] }
 *       { "skipDescriptions": true }   // fast smoke run, no AI text
 *
 *     Same scraper, same upsert path, same enrich-batch fan-out — just
 *     parameterized for one-off historical backfills or NAICS expansion
 *     experiments. Triggered from the Tasks tab in trigger.dev with the
 *     payload as raw JSON.
 *
 * Requires SAM_API_KEY env var on the trigger.dev project (free tier
 * key from api.sam.gov).
 */

type SamBackfillPayload = {
  postedWithinDays?: number;
  maxPagesPerNaics?: number;
  pageSize?: number;
  naicsCodes?: string[];
  skipDescriptions?: boolean;
};

async function runSam(opts: SamBackfillPayload, triggerRunId: string) {
  const scraper = new SamGovScraper(opts);
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

export const scrapeSam = schedules.task({
  id: 'scrape-sam',
  cron: '0 */6 * * *',
  maxDuration: 1800,
  run: async (_payload, { ctx }) => runSam({}, ctx.run.id),
});

export const scrapeSamBackfill = task({
  id: 'scrape-sam-backfill',
  maxDuration: 3600,
  run: async (payload: SamBackfillPayload, { ctx }) => runSam(payload ?? {}, ctx.run.id),
});
