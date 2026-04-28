import { schedules } from '@trigger.dev/sdk';
import { JamaicaGojepAwardsExtractor } from '../../awards-extractors/jamaica-gojep/extractor';

/**
 * Jamaica GOJEP awards extraction.
 *
 * NOT IN THE DEPLOY GLOB. Lives outside `./src/trigger/scheduled/`
 * intentionally. To enable:
 *   1. Add `'./src/trigger/awards'` to trigger.config.ts `dirs`.
 *   2. Set JM_AWARDS_EXTRACTOR_ENABLED=1 on the trigger.dev project.
 *
 * GOJEP publishes awards via per-keyword HTML search + per-award PDF.
 * Each PDF is ~100KB and the parsing layer downloads + extracts them
 * serially — for the historical fuel corpus (~19 awards) the run
 * takes a couple minutes. Cron is monthly (8th, 03:00 UTC) to give
 * GOJEP time to publish the prior month's PDFs after the DR run on
 * the 5th.
 */
export const extractJmAwards = schedules.task({
  id: 'extract-jm-awards',
  cron: '0 3 8 * *',
  maxDuration: 1800,
  run: async (_payload, { ctx }) => {
    const enabled = process.env.JM_AWARDS_EXTRACTOR_ENABLED === '1';
    if (!enabled) {
      return {
        skipped: true,
        reason: 'JM_AWARDS_EXTRACTOR_ENABLED not set — task is intentionally inert.',
      };
    }
    const extractor = new JamaicaGojepAwardsExtractor();
    return await extractor.run({ triggerRunId: ctx.run.id });
  },
});
