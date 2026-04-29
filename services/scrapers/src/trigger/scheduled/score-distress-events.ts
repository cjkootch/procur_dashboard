import { schedules } from '@trigger.dev/sdk';
import { scoreDistressEvents } from '../../jobs/score-distress-events';

/**
 * Daily LLM relevance scoring on entity_news_events rows that
 * landed with NULL — currently EDGAR + RECAP. Cron at 14:00 UTC,
 * which sits AFTER both source workers (EDGAR 12:00, RECAP 13:00)
 * so a same-day backlog is already in the table when this fires.
 *
 * Cap of 100 rows per run keeps cost predictable. If the backlog
 * grows faster than 100/day the cap kicks in — operator can re-run
 * manually with a higher cap (the job is idempotent on
 * relevance_score IS NULL so re-running just picks up unscored
 * rows).
 */
export const scoreDistressEventsScheduled = schedules.task({
  id: 'score-distress-events',
  cron: '0 14 * * *',
  maxDuration: 1500,
  run: async () => {
    const result = await scoreDistressEvents({ limit: 100 });
    console.log(
      `Distress scoring: ${result.scored}/${result.scanned} rows ` +
        `scored (${result.skipped} skipped${
          result.errors.length > 0 ? `, ${result.errors.length} errors` : ''
        }).`,
    );
    if (result.errors.length > 0) {
      for (const e of result.errors.slice(0, 5)) console.log(`  · ${e}`);
    }
    return result;
  },
});
