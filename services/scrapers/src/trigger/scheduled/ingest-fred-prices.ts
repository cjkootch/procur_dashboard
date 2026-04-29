import { schedules } from '@trigger.dev/sdk';
import { ingestFredPrices } from '@procur/db/ingest-fred-prices';

/**
 * FRED daily commodity price ingest (Brent + WTI, USD/bbl).
 *
 * Cron at 14:30 UTC weekdays. FRED's daily series is the prior
 * trading day's spot, published in the morning ET (~13:00 UTC).
 * 14:30 UTC is comfortably after that. Skips weekends since FRED
 * doesn't publish then.
 *
 * Defaults to 2020-01-01 since on first run; subsequent runs are
 * idempotent upserts so a full pull is cheap and catches any
 * retroactive corrections.
 */
export const ingestFredPricesScheduled = schedules.task({
  id: 'ingest-fred-prices',
  cron: '30 14 * * 1-5',
  maxDuration: 600,
  run: async () => {
    const result = await ingestFredPrices({});
    console.log(
      `FRED prices: ${result.totalRowsUpserted} rows across ` +
        `${Object.keys(result.perSeries).length} series since ${result.since}.`,
    );
    return result;
  },
});
