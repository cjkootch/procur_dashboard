import { schedules } from '@trigger.dev/sdk';
import { ingestEcbFx } from '@procur/db/ingest-ecb-fx';

/**
 * ECB daily FX rates → fx_rates.
 *
 * ECB publishes the day's reference rates around 16:00 CET.
 * Cron at 16:30 UTC daily on weekdays — gives ECB a buffer + skips
 * Sat/Sun (no publication) so we don't waste a run polling for nothing.
 *
 * Range: defaults to 2020-01-01 backfill on first run; subsequent runs
 * upsert idempotently so re-running is cheap. We do not pin a recent
 * `since` because the run is cheap (~30 currencies × small CSV) and a
 * full pull catches any retroactive corrections ECB issues.
 *
 * The script logs per-currency upsert counts; the task return value
 * gets persisted in trigger.dev's run history for cron-health checks.
 */
export const ingestEcbFxScheduled = schedules.task({
  id: 'ingest-ecb-fx',
  cron: '30 16 * * 1-5',
  maxDuration: 600,
  run: async () => {
    const result = await ingestEcbFx({});
    console.log(
      `ECB FX: ${result.totalRowsUpserted} rows across ` +
        `${Object.keys(result.perCurrency).length} currencies since ${result.since}`,
    );
    if (result.skippedCurrencies.length > 0) {
      console.log(`Skipped: ${result.skippedCurrencies.join(', ')}`);
    }
    return result;
  },
});
