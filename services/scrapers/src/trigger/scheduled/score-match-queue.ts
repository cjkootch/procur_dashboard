import { schedules } from '@trigger.dev/sdk';
import { scoreMatchQueue } from '../../jobs/score-match-queue';

/**
 * Daily match-queue scoring at 15:30 UTC.
 *
 * Sequenced after every upstream feed has had a chance to land
 * fresh data:
 *   12:00 SEC EDGAR
 *   13:00 RECAP bankruptcy
 *   14:00 distress LLM scoring
 *   14:30 FRED
 *   15:00 EIA
 *   15:30 match queue ← this task
 *   16:30 ECB FX
 *
 * Idempotent on (source_table, source_id) — re-running the same
 * day's scoring after a partial failure is safe.
 */
export const scoreMatchQueueScheduled = schedules.task({
  id: 'score-match-queue',
  cron: '30 15 * * *',
  maxDuration: 600,
  run: async () => {
    const result = await scoreMatchQueue();
    console.log(
      `Match queue: ${result.totalInserted} new rows ` +
        `(${result.distressInserted} distress, ` +
        `${result.velocityInserted} velocity, ` +
        `${result.awardInserted} awards).`,
    );
    return result;
  },
});
