import { schedules } from '@trigger.dev/sdk/v3';
import { JamaicaGojepScraper } from '../jurisdictions/jamaica-gojep/scraper';

/**
 * Run every 4 hours. Brief spec — Part 6 Day 6-7.
 */
export const scrapeJamaica = schedules.task({
  id: 'scrape-jamaica',
  cron: '0 */4 * * *',
  maxDuration: 1800,
  run: async (payload, { ctx }) => {
    const scraper = new JamaicaGojepScraper();
    return scraper.run({ triggerRunId: ctx.run.id });
  },
});
