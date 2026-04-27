import { schedules, tasks } from '@trigger.dev/sdk';
import { GuyanaNptabScraper } from '../../jurisdictions/guyana-nptab/scraper';

export const scrapeGuyana = schedules.task({
  id: 'scrape-guyana',
  cron: '0 */6 * * *',
  maxDuration: 1800,
  run: async (_payload, { ctx }) => {
    const scraper = new GuyanaNptabScraper();
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
