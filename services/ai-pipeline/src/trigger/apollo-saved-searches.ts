import { task } from '@trigger.dev/sdk/v3';
import { and, eq, isNull, lt, or } from 'drizzle-orm';
import {
  db,
  apolloSavedSearches,
  notifications,
  users,
  type ApolloSavedSearch,
  type NewNotification,
} from '@procur/db';
import {
  searchOrgs,
  type ApolloSearchFilters,
} from '@procur/apollo';
import { log } from '@procur/utils/logger';

/**
 * Saved-search runner. Picks every active apollo_saved_searches row
 * whose schedule has elapsed since last_run_at, calls the search,
 * diffs returned org IDs against last_seen_org_ids, and writes a
 * notification per new ID for every active user in the tenant.
 *
 * Spec: docs/apollo-integration-brief.md §5.2.
 *
 * Notifications fan out across the tenant — saved searches are
 * tenant-scoped (commercial intent), and a single hit could be
 * relevant to multiple operators in the company. v1 doesn't model
 * "subscribed users" per saved search; revisit if that becomes a
 * real ergonomic problem.
 */
export const apolloSavedSearchesTask = task({
  id: 'apollo.saved-searches',
  maxDuration: 1800,
  run: async () => {
    const now = new Date();
    const dueRows = await db
      .select()
      .from(apolloSavedSearches)
      .where(
        and(
          eq(apolloSavedSearches.status, 'active'),
          or(
            isNull(apolloSavedSearches.lastRunAt),
            lt(apolloSavedSearches.lastRunAt, dueBefore(now)),
          ),
        ),
      );

    log.info('apollo.saved-searches.scheduled', {
      candidates: dueRows.length,
    });

    let processed = 0;
    let totalHits = 0;
    let totalNotifications = 0;

    for (const search of dueRows) {
      if (!shouldRunNow(search, now)) continue;
      const result = await runSavedSearch(search, now);
      processed += 1;
      totalHits += result.newHits;
      totalNotifications += result.notificationsWritten;
    }

    log.info('apollo.saved-searches.completed', {
      processed,
      newHits: totalHits,
      notificationsWritten: totalNotifications,
    });

    return {
      processed,
      newHits: totalHits,
      notificationsWritten: totalNotifications,
    };
  },
});

async function runSavedSearch(
  search: ApolloSavedSearch,
  now: Date,
): Promise<{ newHits: number; notificationsWritten: number }> {
  const filters = (search.searchFilters ?? {}) as ApolloSearchFilters;
  const result = await searchOrgs(filters, { perPage: 100 });

  if ('ok' in result && result.ok === false) {
    log.warn('apollo.saved-searches.degraded', {
      savedSearchId: search.id,
      reason: result.reason,
      message: result.message,
    });
    // Mark the run timestamp so we don't hammer this saved search;
    // a future cron tick will re-attempt naturally.
    await db
      .update(apolloSavedSearches)
      .set({ lastRunAt: now, updatedAt: now })
      .where(eq(apolloSavedSearches.id, search.id));
    return { newHits: 0, notificationsWritten: 0 };
  }

  if (!('organizations' in result)) return { newHits: 0, notificationsWritten: 0 };

  const currentIds = new Set(result.organizations.map((o) => o.id));
  const previousIds = new Set(search.lastSeenOrgIds);
  const newIds = [...currentIds].filter((id) => !previousIds.has(id));

  let notificationsWritten = 0;

  if (newIds.length > 0 && search.alertMode === 'on-new-match') {
    const tenantUsers = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.companyId, search.companyId));

    const newOrgs = result.organizations.filter((o) => newIds.includes(o.id));
    const rows: NewNotification[] = [];
    for (const u of tenantUsers) {
      for (const org of newOrgs) {
        rows.push({
          userId: u.id,
          companyId: search.companyId,
          type: 'apollo.saved-search-hit',
          title: `${search.name}: ${org.name || org.primaryDomain || org.id}`,
          body: org.primaryDomain
            ? `New match — ${org.primaryDomain}`
            : null,
          link: `/settings/apollo-searches/${search.id}`,
          entityType: 'apollo_saved_search',
          entityId: search.id,
        });
      }
    }
    if (rows.length > 0) {
      await db.insert(notifications).values(rows);
      notificationsWritten = rows.length;
    }
  }

  await db
    .update(apolloSavedSearches)
    .set({
      lastRunAt: now,
      lastSeenOrgIds: [...currentIds],
      updatedAt: now,
    })
    .where(eq(apolloSavedSearches.id, search.id));

  return { newHits: newIds.length, notificationsWritten };
}

/**
 * Per-saved-search schedule check. Saved-search.schedule is a coarse
 * shorthand: 'hourly' | 'daily' | 'weekly'. The cron runs hourly; we
 * gate per-row by elapsed time since last_run_at.
 */
function shouldRunNow(search: ApolloSavedSearch, now: Date): boolean {
  if (!search.lastRunAt) return true;
  const elapsedMs = now.getTime() - search.lastRunAt.getTime();
  switch (search.schedule) {
    case 'hourly':
      return elapsedMs >= 60 * 60 * 1000;
    case 'weekly':
      return elapsedMs >= 7 * 24 * 60 * 60 * 1000;
    case 'daily':
    default:
      return elapsedMs >= 24 * 60 * 60 * 1000;
  }
}

/** Boundary used in the SQL prefilter — anything older than 1h ago is
 *  potentially due (the per-row check then narrows by schedule). */
function dueBefore(now: Date): Date {
  return new Date(now.getTime() - 60 * 60 * 1000);
}
