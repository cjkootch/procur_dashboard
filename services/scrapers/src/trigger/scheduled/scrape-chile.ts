import { schedules, tasks } from '@trigger.dev/sdk';
import { ChileMpScraper } from '../../jurisdictions/chile-mp/scraper';

/**
 * Mercado Público publishes throughout the working day (America/Santiago,
 * UTC-04). 4-hourly cron mirrors the rest of the LATAM/Caribbean fleet.
 *
 * Reads MERCADO_PUBLICO_TICKET from the Trigger.dev project env. Without
 * it the scraper short-circuits to 0 rows + a warning rather than failing
 * the run, so a missing env doesn't redden the dashboard.
 */
export const scrapeChile = schedules.task({
  id: 'scrape-chile',
  cron: '0 */4 * * *',
  maxDuration: 1800,
  run: async (_payload, { ctx }) => {
    const scraper = new ChileMpScraper();
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
