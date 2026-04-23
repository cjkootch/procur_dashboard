import { schedules, tasks } from '@trigger.dev/sdk/v3';
import { JamaicaGojepScraper } from '../jurisdictions/jamaica-gojep/scraper';

export const scrapeJamaica = schedules.task({
  id: 'scrape-jamaica',
  cron: '0 */4 * * *',
  maxDuration: 1800,
  run: async (_payload, { ctx }) => {
    const scraper = new JamaicaGojepScraper();
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
