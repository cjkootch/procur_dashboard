import { task } from '@trigger.dev/sdk/v3';
import { and, isNotNull, isNull, lt, or } from 'drizzle-orm';
import {
  db,
  knownEntities,
  externalSuppliers,
} from '@procur/db';
import {
  enrichOrgsBatch,
  APOLLO_BATCH_FRESHNESS_DAYS,
} from '@procur/apollo';
import { log } from '@procur/utils/logger';

/**
 * Nightly Apollo batch-enrichment over the rolodex. Pulls every
 * (known_entities | external_suppliers) row with a primary_domain
 * that's either never been Apollo-matched or has stale apollo_synced_at,
 * and refreshes the thin snapshot in chunks of 1,000 domains per call.
 *
 * The thin snapshot is just apollo_org_id + apollo_synced_at. Funding,
 * headcount, revenue, and the wide jsonb apollo_snapshot land on the
 * next single-get (triggered when an operator opens the entity profile)
 * — see apollo-integration-brief.md §3.2 / §5.1.
 *
 * Stays in batch-mode to keep credit usage bounded; never calls the
 * paid /organizations/{id} endpoint from the cron.
 *
 * No tenant scope — these calls are global rolodex maintenance, not
 * per-company. credit-log rows have company_id = NULL.
 */
export const apolloBatchEnrichmentTask = task({
  id: 'apollo.batch-enrichment',
  maxDuration: 1800,
  run: async () => {
    const stalenessMs = APOLLO_BATCH_FRESHNESS_DAYS * 24 * 60 * 60 * 1000;
    const staleBoundary = new Date(Date.now() - stalenessMs);

    // Pull stale rows from both entity tables in parallel.
    const [knownRows, externalRows] = await Promise.all([
      db
        .select({ id: knownEntities.id, domain: knownEntities.primaryDomain })
        .from(knownEntities)
        .where(
          and(
            isNotNull(knownEntities.primaryDomain),
            or(
              isNull(knownEntities.apolloSyncedAt),
              lt(knownEntities.apolloSyncedAt, staleBoundary),
            ),
          ),
        ),
      db
        .select({
          id: externalSuppliers.id,
          domain: externalSuppliers.primaryDomain,
        })
        .from(externalSuppliers)
        .where(
          and(
            isNotNull(externalSuppliers.primaryDomain),
            or(
              isNull(externalSuppliers.apolloSyncedAt),
              lt(externalSuppliers.apolloSyncedAt, staleBoundary),
            ),
          ),
        ),
    ]);

    const knownDomains = uniqueDomains(knownRows.map((r) => r.domain));
    const externalDomains = uniqueDomains(externalRows.map((r) => r.domain));

    log.info('apollo.batch-enrichment.scheduled', {
      knownDomains: knownDomains.length,
      externalDomains: externalDomains.length,
      stalenessDays: APOLLO_BATCH_FRESHNESS_DAYS,
    });

    let totalMatched = 0;
    let totalApiCalls = 0;
    const totalUnmatched: string[] = [];

    if (knownDomains.length > 0) {
      const result = await enrichOrgsBatch({
        domains: knownDomains,
        targetTable: 'known_entities',
      });
      if ('ok' in result && result.ok === false) {
        log.warn('apollo.batch-enrichment.degraded', {
          target: 'known_entities',
          reason: result.reason,
          message: result.message,
        });
      } else if ('matched' in result) {
        totalMatched += result.matched;
        totalApiCalls += result.apiCalls;
        totalUnmatched.push(...result.unmatched);
      }
    }

    if (externalDomains.length > 0) {
      const result = await enrichOrgsBatch({
        domains: externalDomains,
        targetTable: 'external_suppliers',
      });
      if ('ok' in result && result.ok === false) {
        log.warn('apollo.batch-enrichment.degraded', {
          target: 'external_suppliers',
          reason: result.reason,
          message: result.message,
        });
      } else if ('matched' in result) {
        totalMatched += result.matched;
        totalApiCalls += result.apiCalls;
        totalUnmatched.push(...result.unmatched);
      }
    }

    log.info('apollo.batch-enrichment.completed', {
      matched: totalMatched,
      unmatched: totalUnmatched.length,
      apiCalls: totalApiCalls,
    });

    return {
      knownDomains: knownDomains.length,
      externalDomains: externalDomains.length,
      matched: totalMatched,
      unmatched: totalUnmatched.length,
      apiCalls: totalApiCalls,
    };
  },
});

function uniqueDomains(domains: Array<string | null>): string[] {
  const set = new Set<string>();
  for (const d of domains) {
    if (!d) continue;
    set.add(d.toLowerCase());
  }
  return [...set];
}
