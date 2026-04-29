import { schedules } from '@trigger.dev/sdk';
import { ingestEiaPrices } from '@procur/db/ingest-eia-prices';

/**
 * EIA daily NYH refined-product spot ingest (ULSD / RBOB / heating
 * oil, USD/gal).
 *
 * Cron at 15:00 UTC weekdays. EIA publishes the prior trading day's
 * spot in the morning ET; 15:00 UTC sits well after the typical
 * publication window and after FRED's 14:30 cron so DB writes
 * stagger.
 *
 * Skips weekends (no publication). No-ops cleanly when EIA_API_KEY
 * is missing — the underlying ingestEiaPrices() returns
 * {skipped:true} which the cron logs but treats as success so the
 * dashboard doesn't show a fake red.
 */
export const ingestEiaPricesScheduled = schedules.task({
  id: 'ingest-eia-prices',
  cron: '0 15 * * 1-5',
  maxDuration: 600,
  run: async () => {
    const result = await ingestEiaPrices({});
    if (result.skipped) {
      console.warn('EIA prices skipped: EIA_API_KEY not set in trigger env.');
      return result;
    }
    console.log(
      `EIA prices: ${result.totalRowsUpserted} rows across ` +
        `${Object.keys(result.perSeries).length} series since ${result.since}.`,
    );
    return result;
  },
});
