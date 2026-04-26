import { schedules, tasks } from '@trigger.dev/sdk/v3';
import { JamaicaGojepCurrentScraper } from '../../jurisdictions/jamaica-gojep-current/scraper';

/**
 * GOJEP Current Competitions — authenticated. 4-hourly cron mirrors
 * the rest of the fleet. Reads GOJEP_SESSION_COOKIE from the
 * Trigger.dev project env; without it the scraper short-circuits to
 * 0 rows + a warning rather than failing the run, so a stale cookie
 * doesn't redden the dashboard for the few minutes it takes to
 * refresh.
 *
 * Sessions on the e-PPS server commonly idle out at 30 minutes and
 * hard-cap at 8–24h. When the scraper sees a login redirect it logs
 * `jamaica_current.session_expired` so the on-call hook can fire.
 * A future iteration will move the cookie to a DB column with an
 * automated re-login; v1 keeps it in env for simplicity.
 */
export const scrapeJamaicaCurrent = schedules.task({
  id: 'scrape-jamaica-current',
  cron: '0 */4 * * *',
  maxDuration: 1800,
  run: async (_payload, { ctx }) => {
    const scraper = new JamaicaGojepCurrentScraper();
    const result = await scraper.run({ triggerRunId: ctx.run.id });

    if (result.insertedIds.length > 0) {
      await tasks.batchTrigger(
        'opportunity.enrich',
        result.insertedIds.map((opportunityId: string) => ({ payload: { opportunityId } })),
      );
    }

    return result;
  },
});
