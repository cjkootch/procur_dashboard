import { task } from '@trigger.dev/sdk';
import { UngmAwardsExtractor } from '../../awards-extractors/ungm/extractor';

/**
 * UNGM awards backfill — manual one-shot for seeding past-winner data.
 *
 * Distinct from `extract-un-awards` (the weekly Tuesday cron, which
 * is gated behind UNGM_AWARDS_EXTRACTOR_ENABLED=1 and uses the
 * extractor's default 5-page sweep). This task is for explicit
 * historical seeding from the Trigger.dev dashboard:
 *
 *   { "maxPages": 30 }            ~3k notices, deeper history
 *   { "pageSize": 100 }           explicit page-size override
 *
 * Defaults: maxPages=30, pageSize=100 (3,000 award notices).
 *
 * UNGM's search has no time filter — it's recency-ordered, so the
 * way to fetch deeper history is to walk more pages. The two-step
 * pipeline (search + per-notice detail fetch) is the slowest of all
 * extractors; expect a long-running task. maxDuration is set to one
 * hour.
 *
 * The trigger itself IS the consent — no env gate. The extractor is
 * idempotent on (source_portal, source_award_id), so re-runs are safe.
 */
type UnBackfillPayload = {
  maxPages?: number;
  pageSize?: number;
};

export const extractUnAwardsBackfill = task({
  id: 'extract-un-awards-backfill',
  maxDuration: 3600,
  run: async (payload: UnBackfillPayload, { ctx }) => {
    const opts = payload ?? {};
    const extractor = new UngmAwardsExtractor({
      maxPages: opts.maxPages ?? 30,
      pageSize: opts.pageSize ?? 100,
    });
    return await extractor.run({ triggerRunId: ctx.run.id });
  },
});
