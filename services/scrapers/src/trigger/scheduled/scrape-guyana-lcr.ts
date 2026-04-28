import { schedules, tasks } from '@trigger.dev/sdk';
import { GuyanaLcrScraper } from '../../jurisdictions/guyana-lcr/scraper';

/**
 * Local Content Register feed — operator-driven oil & gas tenders.
 * Posting cadence is roughly daily (~5-15 new notices per day),
 * so 4-hour cron mirrors the NPTA + Jamaica scrapers and keeps
 * pickup latency under half a day.
 */
export const scrapeGuyanaLcr = schedules.task({
  id: 'scrape-guyana-lcr',
  cron: '0 */4 * * *',
  maxDuration: 1800,
  run: async (_payload, { ctx }) => {
    const scraper = new GuyanaLcrScraper();
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
