/**
 * Trinidad and Tobago — eGP procurement portal.
 *
 * Portal: https://egp.gov.tt
 *
 * Currently NOT deployed — file lives in src/trigger/ which is outside
 * the trigger.config.ts `dirs: ['./src/trigger/scheduled']` glob, so
 * trigger.dev's bundler skips it.
 *
 * Why disabled: the eGP portal sits behind a JavaScript bot challenge
 * that defeats plain HTTP fetches, so this scraper drives a headless
 * Chromium via Playwright. The @trigger.dev/build@4.4.4 playwright
 * extension we'd need ships with a hard-coded reference to
 * `chromium-headless-shell` (a Playwright 1.49+ binary) and runs a
 * docker `grep -A5 -m1 "browser: chromium-headless-shell"` against
 * `playwright install --dry-run` output. The grep fails because the
 * dry-run command doesn't list chromium-headless-shell in its default
 * output, blocking the entire scrapers deploy when this task is in
 * scope.
 *
 * To re-enable later, options are:
 *   1. Wait for @trigger.dev/build to fix the grep (track upstream).
 *   2. Switch Trinidad to an external rendering service
 *      (Browserless, ScrapingBee) so it can stay on the cheerio-based
 *      scraper architecture.
 *   3. Move Trinidad to a separate Vercel cron job that runs Playwright
 *      in a custom Node container outside Trigger.dev.
 *
 * Cycle (when re-enabled): every 4 hours, offset :45 from other
 * Caribbean scrapers to spread load. Trinidad's eGP publishes
 * throughout the working day (America/Port_of_Spain).
 */
import { schedules, tasks } from '@trigger.dev/sdk';
import { TrinidadEgpScraper } from '../jurisdictions/trinidad-egp/scraper';

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
