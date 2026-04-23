import { schedules } from '@trigger.dev/sdk/v3';
import { TrinidadEgpScraper } from '../jurisdictions/trinidad-egp/scraper';

/** Run every 4 hours. Uses Playwright + headless Chromium. */
export const scrapeTrinidad = schedules.task({
  id: 'scrape-trinidad',
  cron: '0 */4 * * *',
  maxDuration: 1800,
  run: async (_payload, { ctx }) => {
    const scraper = new TrinidadEgpScraper();
    return scraper.run({ triggerRunId: ctx.run.id });
  },
});
