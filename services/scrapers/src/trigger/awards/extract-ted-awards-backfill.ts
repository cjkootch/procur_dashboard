import { task } from '@trigger.dev/sdk';
import { TedAwardsExtractor } from '../../awards-extractors/ted/extractor';

/**
 * TED awards backfill — manual one-shot for seeding past-winner data.
 *
 * Distinct from `extract-ted-awards` (the weekly Monday cron, which
 * is gated behind TED_AWARDS_EXTRACTOR_ENABLED=1 and uses a 14-day
 * lookback). This task is for explicit historical seeding from the
 * Trigger.dev dashboard:
 *
 *   { "postedWithinDays": 365 }                    one full year
 *   { "postedWithinDays": 90, "cpvPrefixes": ["09"] }  fuel only
 *   { "cpvPrefixes": [] }                          all CPV families
 *   { "maxPages": 100 }                            ~25k notices cap
 *
 * Defaults: postedWithinDays=180 (six months), cpvPrefixes=['09','15']
 * (fuel + food), maxPages=40 (~10k notices).
 *
 * The trigger itself IS the consent — no env gate. The user firing
 * this task explicitly wants the data. The extractor is idempotent
 * on (source_portal, source_award_id), so re-runs are safe.
 */
type TedBackfillPayload = {
  postedWithinDays?: number;
  cpvPrefixes?: string[];
  maxPages?: number;
};

export const extractTedAwardsBackfill = task({
  id: 'extract-ted-awards-backfill',
  maxDuration: 3600,
  run: async (payload: TedBackfillPayload, { ctx }) => {
    const opts = payload ?? {};
    const extractor = new TedAwardsExtractor({
      postedWithinDays: opts.postedWithinDays ?? 180,
      cpvPrefixes: opts.cpvPrefixes,
      maxPages: opts.maxPages ?? 40,
    });
    return await extractor.run({ triggerRunId: ctx.run.id });
  },
});
