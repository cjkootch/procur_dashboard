import { schedules } from '@trigger.dev/sdk/v3';
import { GuyanaNptabScraper } from '../jurisdictions/guyana-nptab/scraper';

/** Run every 6 hours. */
export const scrapeGuyana = schedules.task({
  id: 'scrape-guyana',
  cron: '0 */6 * * *',
  maxDuration: 1800,
  run: async (_payload, { ctx }) => {
    const scraper = new GuyanaNptabScraper();
    return scraper.run({ triggerRunId: ctx.run.id });
  },
});
