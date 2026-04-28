import { schedules, tasks } from '@trigger.dev/sdk';
import { ChileMpSessionScraper } from '../../jurisdictions/chile-mp-session/scraper';

/**
 * Mercado Público (authenticated supplier-session route). 4-hourly
 * cron mirrors the rest of the fleet. Reads MERCADO_PUBLICO_SESSION_COOKIE
 * from the Trigger.dev project env (semicolon-separated `name=value`
 * pairs, e.g. `ASP.NET_SessionId=...; access_token_ccr=...`). Without
 * it the scraper short-circuits to 0 rows + a warning so a stale or
 * missing cookie doesn't redden the dashboard.
 *
 * ASP.NET sessions typically idle out at 20 min and hard-cap at 8h.
 * When the scraper sees the Keycloak login redirect it logs
 * `chile_session.session_expired` so the on-call hook can fire.
 */
export const scrapeChileSession = schedules.task({
  id: 'scrape-chile-session',
  cron: '0 */4 * * *',
  maxDuration: 1800,
  run: async (_payload, { ctx }) => {
    const scraper = new ChileMpSessionScraper();
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
