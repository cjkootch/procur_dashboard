/**
 * One-off Apollo batch enrichment script. Equivalent to the
 * apollo-batch-enrichment Trigger.dev cron, but runs locally — for
 * use until the Trigger.dev SDK is upgraded from v3 to v4 and the
 * cron can deploy again.
 *
 * Pulls every (known_entities | external_suppliers) row with a
 * primary_domain that's stale or unmatched, calls
 * enrichOrgsBatch (one /mixed_companies/search call per 1,000
 * domains), and writes back the thin snapshot.
 *
 * Run from services/ai-pipeline:
 *
 *   APOLLO_ENABLED=true \
 *   APOLLO_MASTER_API_KEY=<your-key> \
 *   DATABASE_URL='<prod-neon-url>' \
 *   pnpm apollo:batch-enrich
 *
 * Idempotent. Safe to run repeatedly. Cost: ~1 search call per
 * 1,000 domains, regardless of how many entities exist.
 */
import 'dotenv/config';
import { and, isNotNull, isNull, lt, or } from 'drizzle-orm';
import {
  db,
  knownEntities,
  externalSuppliers,
} from '@procur/db';
import {
  enrichOrgsBatch,
  APOLLO_BATCH_FRESHNESS_DAYS,
  loadApolloConfig,
} from '@procur/apollo';

async function main() {
  const config = loadApolloConfig();
  if (!config.enabled) {
    console.error('APOLLO_ENABLED is not set to "true". Aborting.');
    process.exit(1);
  }
  if (!config.masterApiKey) {
    console.error('APOLLO_MASTER_API_KEY is not set. Aborting.');
    process.exit(1);
  }

  const stalenessMs = APOLLO_BATCH_FRESHNESS_DAYS * 24 * 60 * 60 * 1000;
  const staleBoundary = new Date(Date.now() - stalenessMs);

  console.log(`Apollo batch enrichment — staleness window ${APOLLO_BATCH_FRESHNESS_DAYS} days`);

  const [knownRows, externalRows] = await Promise.all([
    db
      .select({ domain: knownEntities.primaryDomain })
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
      .select({ domain: externalSuppliers.primaryDomain })
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

  const knownDomains = unique(knownRows.map((r) => r.domain));
  const externalDomains = unique(externalRows.map((r) => r.domain));

  console.log(
    `  known_entities domains: ${knownDomains.length}\n` +
      `  external_suppliers domains: ${externalDomains.length}`,
  );

  let totalMatched = 0;
  let totalApiCalls = 0;
  const totalUnmatched: string[] = [];

  if (knownDomains.length > 0) {
    console.log(`\nEnriching ${knownDomains.length} known_entities domains…`);
    const result = await enrichOrgsBatch({
      domains: knownDomains,
      targetTable: 'known_entities',
    });
    if ('ok' in result && result.ok === false) {
      console.error(`  degraded: ${result.reason} — ${result.message}`);
    } else if ('matched' in result) {
      totalMatched += result.matched;
      totalApiCalls += result.apiCalls;
      totalUnmatched.push(...result.unmatched);
      console.log(
        `  matched ${result.matched} of ${knownDomains.length} (${result.apiCalls} API call${result.apiCalls === 1 ? '' : 's'})`,
      );
    }
  }

  if (externalDomains.length > 0) {
    console.log(`\nEnriching ${externalDomains.length} external_suppliers domains…`);
    const result = await enrichOrgsBatch({
      domains: externalDomains,
      targetTable: 'external_suppliers',
    });
    if ('ok' in result && result.ok === false) {
      console.error(`  degraded: ${result.reason} — ${result.message}`);
    } else if ('matched' in result) {
      totalMatched += result.matched;
      totalApiCalls += result.apiCalls;
      totalUnmatched.push(...result.unmatched);
      console.log(
        `  matched ${result.matched} of ${externalDomains.length} (${result.apiCalls} API call${result.apiCalls === 1 ? '' : 's'})`,
      );
    }
  }

  console.log(
    `\nDone. Matched ${totalMatched} entities; ${totalUnmatched.length} unmatched; ${totalApiCalls} API call${totalApiCalls === 1 ? '' : 's'}.`,
  );
  if (totalUnmatched.length > 0 && totalUnmatched.length <= 30) {
    console.log(`Unmatched domains:\n  ${totalUnmatched.join('\n  ')}`);
  }
}

function unique(arr: Array<string | null>): string[] {
  const set = new Set<string>();
  for (const v of arr) if (v) set.add(v.toLowerCase());
  return [...set];
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
