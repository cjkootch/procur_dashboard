import { schedules, tasks } from '@trigger.dev/sdk/v3';
import { TrinidadEgpScraper } from '../jurisdictions/trinidad-egp/scraper';

export const scrapeTrinidad = schedules.task({
  id: 'scrape-trinidad',
  cron: '0 */4 * * *',
  maxDuration: 1800,
  run: async (_payload, { ctx }) => {
    const scraper = new TrinidadEgpScraper();
    const result = await scraper.run({ triggerRunId: ctx.run.id });

    if (result.insertedIds.length > 0) {
      await tasks.batchTrigger(
        'opportunity.enrich',
        result.insertedIds.map((opportunityId) => ({ payload: { opportunityId } })),
      );
    }

    return result;
  },
});
