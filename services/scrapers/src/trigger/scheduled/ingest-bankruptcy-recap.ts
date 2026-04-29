import { schedules } from '@trigger.dev/sdk';
import { ingestBankruptcyRecap } from '@procur/db/ingest-bankruptcy-recap';

/**
 * Daily Chapter 11 / 7 / 15 bankruptcy ingest from CourtListener
 * (RECAP — free public archive of US federal-court PACER filings).
 *
 * Daily at 13:00 UTC — slightly after SEC EDGAR (12:00) so cron load
 * staggers. RECAP indexes new dockets within hours of the original
 * PACER filing; a 2-day lookback covers cron drift + weekend gaps.
 *
 * Fuzzy-name match against known_entities + external_suppliers
 * filters down to bankruptcies of counterparties we're tracking.
 * Bankruptcies of unrelated companies pass through silently.
 *
 * Optional COURTLISTENER_API_TOKEN env lifts the rate limit; runs
 * unauthenticated otherwise.
 */
export const ingestBankruptcyRecapScheduled = schedules.task({
  id: 'ingest-bankruptcy-recap',
  cron: '0 13 * * *',
  maxDuration: 1800,
  run: async () => {
    const result = await ingestBankruptcyRecap({ daysBack: 2 });
    console.log(
      `RECAP bankruptcy: ${result.hitsInserted} new events from ` +
        `${result.matchesFound} entity matches across ${result.docketsScanned} ` +
        `dockets scanned (${result.hitsSkippedDuplicate} dupes).`,
    );
    if (result.errors.length > 0) {
      console.log(`RECAP bankruptcy errors: ${result.errors.length}`);
      for (const e of result.errors.slice(0, 5)) console.log(`  · ${e}`);
    }
    return result;
  },
});
