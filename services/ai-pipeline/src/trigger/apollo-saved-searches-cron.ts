import { schedules } from '@trigger.dev/sdk/v3';
import { apolloSavedSearchesTask } from './apollo-saved-searches';

/**
 * Hourly cron that fans out the Apollo saved-search runner. The
 * runner itself filters per-row by `schedule` ('hourly' / 'daily' /
 * 'weekly') and `last_run_at`, so calling it hourly is the right
 * resolution — daily/weekly searches will simply skip until they're
 * due.
 *
 * Spec: docs/apollo-integration-brief.md §5.2.
 */
export const apolloSavedSearchesCron = schedules.task({
  id: 'apollo.saved-searches-cron',
  cron: '0 * * * *',
  maxDuration: 1800,
  run: async () => {
    const result = await apolloSavedSearchesTask.triggerAndWait();
    return result;
  },
});
