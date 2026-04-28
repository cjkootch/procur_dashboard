/**
 * Trinidad and Tobago — eGP procurement portal.
 *
 * Portal: https://egp.gov.tt
 *
 * The eGP portal sits behind a JavaScript bot challenge that defeats
 * plain HTTP fetches, so this scraper drives a headless Chromium via
 * Playwright (PlaywrightFetcher). The playwright() build extension in
 * trigger.config.ts installs the browser + its system deps into the
 * deploy image so the scheduled task can launch chromium at runtime.
 *
 * Cycle: every 4 hours, offset :45 from other Caribbean scrapers to
 * spread load. Trinidad's eGP publishes throughout the working day
 * (America/Port_of_Spain).
 */
import { schedules, tasks } from '@trigger.dev/sdk';
import { TrinidadEgpScraper } from '../../jurisdictions/trinidad-egp/scraper';

export const scrapeTrinidad = schedules.task({
  id: 'scrape-trinidad',
  cron: '45 */4 * * *',
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
