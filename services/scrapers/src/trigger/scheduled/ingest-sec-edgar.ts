import { schedules } from '@trigger.dev/sdk';
import { ingestSecEdgar } from '@procur/db/ingest-sec-edgar';

/**
 * SEC EDGAR daily distress-keyword ingest.
 *
 * Daily at 12:00 UTC. SEC publishes EDGAR filings throughout the
 * trading day and after market close — by noon UTC the previous US
 * business day's late-afternoon filings have all landed. Two-day
 * lookback handles weekend/holiday gaps without double-counting
 * (idempotency comes from the (source, source_doc_id) unique index
 * on entity_news_events).
 *
 * Watchlist is sourced from known_entities.metadata.sec_cik. On a
 * fresh DB the worker exits cleanly with watchlistSize=0; analyst
 * curation populates the CIKs. v2 will add an automatic CIK
 * resolution from the SEC bulk company-tickers file.
 */
export const ingestSecEdgarScheduled = schedules.task({
  id: 'ingest-sec-edgar',
  cron: '0 12 * * *',
  maxDuration: 1800,
  run: async () => {
    const result = await ingestSecEdgar({ daysBack: 2 });
    console.log(
      `SEC EDGAR: ${result.hitsInserted} new events from ${result.filingsScanned} ` +
        `filings across ${result.watchlistSize} CIK watchlist (${result.hitsSkippedDuplicate} dupes).`,
    );
    if (result.errors.length > 0) {
      console.log(`SEC EDGAR errors: ${result.errors.length}`);
      for (const e of result.errors.slice(0, 5)) console.log(`  · ${e}`);
    }
    return result;
  },
});
