import { schedules, tasks } from '@trigger.dev/sdk/v3';
import { ColombiaSecopScraper } from '../../jurisdictions/colombia-secop/scraper';

/**
 * SECOP II is open data via Socrata — no auth needed. 4-hourly cron
 * matches the Caribbean / DR / Chile fleet. The scraper paginates
 * through every Abierto process with a future deadline; current volume
 * is ~500 active processes that close daily.
 *
 * Optionally honours DATOS_GOV_CO_APP_TOKEN for higher rate limits if
 * the env var is set on the Trigger.dev project; works without it.
 */
export const scrapeColombia = schedules.task({
  id: 'scrape-colombia',
  cron: '0 */4 * * *',
  maxDuration: 1800,
  run: async (_payload, { ctx }) => {
    const scraper = new ColombiaSecopScraper();
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
