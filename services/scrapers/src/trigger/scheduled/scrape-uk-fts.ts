import { schedules, task, tasks } from '@trigger.dev/sdk';
import { UkFtsScraper } from '../../jurisdictions/uk-fts/scraper';

/**
 * UK Find a Tender Service (FTS) — UK federal procurement, filtered to
 * VTC's commodity CPV families (15* food, 09* fuel, 34* vehicles,
 * 14* minerals).
 *
 * Two entry points:
 *
 *   `scrape-uk-fts` (scheduled, every 4h)
 *     7-day rolling window. UK MoD overseas procurements (Cyprus
 *     SBAs, Falklands, BIOT, BATUK Kenya) get tagged with the
 *     overseas country as beneficiaryCountry — others default to
 *     "United Kingdom".
 *
 *   `scrape-uk-fts-backfill` (regular task, manual trigger)
 *     Custom payload for ad-hoc runs:
 *       { "postedWithinDays": 30 }                    // wider window
 *       { "cpvPrefixes": [] }                         // ingest everything goods
 *       { "includeServicesAndWorks": true }           // beyond goods
 *       { "maxPages": 500 }                           // remove the 200-page cap
 *
 * No auth — UK FTS OCDS endpoints are public.
 */

type UkFtsBackfillPayload = {
  postedWithinDays?: number;
  cpvPrefixes?: string[];
  includeServicesAndWorks?: boolean;
  maxPages?: number;
};

async function runUkFts(opts: UkFtsBackfillPayload, triggerRunId: string) {
  const scraper = new UkFtsScraper(opts);
  const result = await scraper.run({ triggerRunId });

  if (result.insertedIds.length > 0) {
    await tasks.batchTrigger(
      'opportunity.enrich',
      result.insertedIds.map((opportunityId: string) => ({
        payload: { opportunityId },
      })),
    );
  }

  return result;
}

export const scrapeUkFts = schedules.task({
  id: 'scrape-uk-fts',
  cron: '30 */4 * * *',
  maxDuration: 1800,
  run: async (_payload, { ctx }) => runUkFts({}, ctx.run.id),
});

export const scrapeUkFtsBackfill = task({
  id: 'scrape-uk-fts-backfill',
  maxDuration: 3600,
  run: async (payload: UkFtsBackfillPayload, { ctx }) =>
    runUkFts(payload ?? {}, ctx.run.id),
});
