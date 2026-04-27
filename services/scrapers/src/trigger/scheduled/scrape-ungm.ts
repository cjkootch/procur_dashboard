import { schedules, tasks } from '@trigger.dev/sdk/v3';
import { UngmScraper } from '../../jurisdictions/ungm/scraper';

/**
 * UNGM (UN Global Marketplace) — multilateral procurement covering
 * WFP food aid, UNDP fuel, peacekeeping rations, IAEA, FAO, etc.
 *
 * Cycle: every 2 hours. UNGM publishes throughout the working day
 * across all UN time zones (Geneva, NYC, Nairobi, Bangkok). 2h
 * keeps fresh notices visible quickly for VTC commodity buyers
 * watching for fuel/food/mineral RFPs to drop.
 *
 * Public API; no auth required for v1. ~80% of notices are public;
 * authenticated supplier coverage is a separate scraper if/when we
 * decide it's worth maintaining UNGM credentials in trigger.dev env.
 */
export const scrapeUngm = schedules.task({
  id: 'scrape-ungm',
  cron: '0 */2 * * *',
  maxDuration: 1800,
  run: async (_payload, { ctx }) => {
    const scraper = new UngmScraper();
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
