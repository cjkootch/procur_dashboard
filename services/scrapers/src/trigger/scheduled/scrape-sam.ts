import { schedules, tasks } from '@trigger.dev/sdk';
import { SamGovScraper } from '../../jurisdictions/sam-gov/scraper';

/**
 * SAM.gov — US federal procurement, filtered to VTC's commodity NAICS
 * (food, fuel, vehicles, minerals).
 *
 * Cycle: every 6 hours. SAM publishes throughout the federal business
 * day across all US time zones; 6h gives us 4 refreshes per day, which
 * is enough for opportunities that typically have 14-30 day response
 * windows. Cheaper than UNGM's 2h cadence because SAM's API is
 * authenticated and rate-limited.
 *
 * Requires SAM_API_KEY env var on the trigger.dev project (free tier
 * key from api.sam.gov).
 */
export const scrapeSam = schedules.task({
  id: 'scrape-sam',
  cron: '0 */6 * * *',
  maxDuration: 1800,
  run: async (payload, { ctx }) => {
    const scraper = new SamGovScraper({
      // Allow ad-hoc triggering with overrides — useful for backfills
      // ("scrape last 90 days") or one-off NAICS expansions.
      postedWithinDays: (payload as { postedWithinDays?: number } | undefined)
        ?.postedWithinDays,
      maxPagesPerNaics: (payload as { maxPagesPerNaics?: number } | undefined)
        ?.maxPagesPerNaics,
      naicsCodes: (payload as { naicsCodes?: string[] } | undefined)?.naicsCodes,
    });
    const result = await scraper.run({ triggerRunId: ctx.run.id });

    if (result.insertedIds.length > 0) {
      await tasks.batchTrigger(
        'opportunity.enrich',
        result.insertedIds.map((opportunityId: string) => ({ payload: { opportunityId } })),
      );
    }

    return result;
  },
});
