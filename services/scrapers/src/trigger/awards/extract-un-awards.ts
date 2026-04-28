import { schedules } from '@trigger.dev/sdk';
import { UngmAwardsExtractor } from '../../awards-extractors/ungm/extractor';

/**
 * UNGM awards extraction — UN agency contract awards (WFP, UNHCR,
 * UNICEF, WHO, etc.) for fuel + food.
 *
 * NOT IN THE DEPLOY GLOB. Lives outside `./src/trigger/scheduled/`
 * until trigger.config.ts adds `./src/trigger/awards`. Env-gated by
 * UNGM_AWARDS_EXTRACTOR_ENABLED=1.
 *
 * Two-step pipeline (search + per-notice detail fetch) makes this
 * the slowest extractor — running once per week minimizes pressure
 * on UNGM. Detail-page parsing is best-effort; real-world signal
 * arrives only after enough volume accumulates to validate selectors.
 */
export const extractUnAwards = schedules.task({
  id: 'extract-un-awards',
  cron: '0 5 * * 2', // Tuesdays at 05:00 UTC (after the TED Monday run)
  maxDuration: 1800,
  run: async (_payload, { ctx }) => {
    const enabled = process.env.UNGM_AWARDS_EXTRACTOR_ENABLED === '1';
    if (!enabled) {
      return {
        skipped: true,
        reason: 'UNGM_AWARDS_EXTRACTOR_ENABLED not set — task is intentionally inert.',
      };
    }
    const extractor = new UngmAwardsExtractor();
    return await extractor.run({ triggerRunId: ctx.run.id });
  },
});
