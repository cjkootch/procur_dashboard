import { schedules } from '@trigger.dev/sdk';
import { TedAwardsExtractor } from '../../awards-extractors/ted/extractor';

/**
 * TED awards extraction — EU contract award notices for fuel + food.
 *
 * NOT IN THE DEPLOY GLOB. Lives outside `./src/trigger/scheduled/` until
 * trigger.config.ts adds `./src/trigger/awards`. Env-gated by
 * TED_AWARDS_EXTRACTOR_ENABLED=1.
 *
 * TED publishes daily Brussels-time. Awards lag tender opening by weeks/
 * months — once-per-week cadence catches the freshest awards without
 * over-polling the API.
 */
export const extractTedAwards = schedules.task({
  id: 'extract-ted-awards',
  cron: '0 4 * * 1', // Mondays at 04:00 UTC
  maxDuration: 1800,
  run: async (_payload, { ctx }) => {
    const enabled = process.env.TED_AWARDS_EXTRACTOR_ENABLED === '1';
    if (!enabled) {
      return {
        skipped: true,
        reason: 'TED_AWARDS_EXTRACTOR_ENABLED not set — task is intentionally inert.',
      };
    }
    const days = process.env.TED_AWARDS_LOOKBACK_DAYS
      ? Number.parseInt(process.env.TED_AWARDS_LOOKBACK_DAYS, 10)
      : 14;
    const extractor = new TedAwardsExtractor({ postedWithinDays: days });
    return await extractor.run({ triggerRunId: ctx.run.id });
  },
});
