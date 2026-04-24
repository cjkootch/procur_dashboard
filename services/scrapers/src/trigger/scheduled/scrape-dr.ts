import { schedules, tasks } from '@trigger.dev/sdk/v3';
import { DrDgcpScraper } from '../../jurisdictions/dr-dgcp/scraper';

/**
 * DGCP publishes new convocatorias throughout the working day (DR is on
 * America/Santo_Domingo, UTC-04). Every 4 hours mirrors Jamaica/Trinidad.
 */
export const scrapeDr = schedules.task({
  id: 'scrape-dr',
  cron: '0 */4 * * *',
  maxDuration: 1800,
  run: async (_payload, { ctx }) => {
    const scraper = new DrDgcpScraper();
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
