import { schedules } from '@trigger.dev/sdk/v3';
import { apolloBatchEnrichmentTask } from './apollo-batch-enrichment';

/**
 * Nightly cron that fires the Apollo batch-enrichment task. Per
 * apollo-integration-brief.md §5.1: runs at 02:00 UTC, refreshes the
 * thin snapshot for every rolodex entity with a primary_domain that's
 * stale or unmatched.
 *
 * Tuned to mirror the existing translations-backfill cron — same hour,
 * different concern. Both run during low-traffic Caribbean / LATAM
 * scraper windows so cumulative load stays manageable.
 */
export const apolloBatchEnrichmentCron = schedules.task({
  id: 'apollo.batch-enrichment-cron',
  cron: '0 2 * * *',
  maxDuration: 1800,
  run: async () => {
    const result = await apolloBatchEnrichmentTask.triggerAndWait();
    return result;
  },
});
