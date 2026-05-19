/**
 * Apollo enrichment for known_entities — local CLI wrapper.
 *
 * Targets rolodex rows missing primary_domain. The GAIN-promoted
 * cohort is the primary use case — those entities were auto-created
 * from GAIN report mentions without Apollo coverage.
 *
 * Loops `enrichKnownEntitiesViaApollo` until either:
 *   - All eligible rows are processed (remaining=0)
 *   - Three consecutive no-progress iterations (rate-limited).
 *
 * Idempotent on `apollo_synced_at`. Re-runs with KE_APOLLO_STALE_HOURS
 * force refresh of rows older than N hours.
 *
 * Run from repo root:
 *   # Enrich just GAIN-promoted entities (recommended first pass):
 *   KE_APOLLO_TAG_FILTER=gain-curated pnpm --filter @procur/apollo enrich-known-entities
 *
 *   # All untouched rows:
 *   pnpm --filter @procur/apollo enrich-known-entities
 *
 * Env:
 *   DATABASE_URL                       # required
 *   APOLLO_MASTER_API_KEY              # required (apollo client)
 *   APOLLO_RATE_LIMIT_PER_HOUR=3000    # raise from default 500 on paid plan
 *   KE_APOLLO_BATCH_SIZE=200           # rows per loop iteration
 *   KE_APOLLO_TAG_FILTER=gain-curated  # optional; restrict to entities w/ tag
 *   KE_APOLLO_COUNTRY=VE               # optional; restrict to ISO-2
 *   KE_APOLLO_STALE_HOURS=720          # optional; refresh rows older than this
 */
import 'dotenv/config';
import { config as loadEnv } from 'dotenv';
import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import * as schema from '@procur/db';
import { enrichKnownEntitiesViaApollo } from '../known-entities-enrich';
import { getApolloRateLimitPerHour } from '../config';

loadEnv({ path: '../../.env.local' });
loadEnv({ path: '../../.env' });

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required.');
  }
  const db = drizzle(neon(process.env.DATABASE_URL), { schema });
  const limit = Number.parseInt(
    process.env.KE_APOLLO_BATCH_SIZE ?? '200',
    10,
  );
  const tagFilter = process.env.KE_APOLLO_TAG_FILTER;
  const countryFilter = process.env.KE_APOLLO_COUNTRY;
  const staleHoursRaw = process.env.KE_APOLLO_STALE_HOURS;
  const staleHours = staleHoursRaw
    ? Number.parseInt(staleHoursRaw, 10)
    : undefined;

  console.log(
    `[ke-apollo] starting — batch=${limit}${tagFilter ? ` tag=${tagFilter}` : ''}${countryFilter ? ` country=${countryFilter}` : ''}${staleHours ? ` staleHours=${staleHours}` : ''} rateLimitPerHour=${getApolloRateLimitPerHour()}`,
  );

  let totalProcessed = 0;
  let totalMatched = 0;
  let totalUnmatched = 0;
  let noProgressIterations = 0;

  while (true) {
    const result = await enrichKnownEntitiesViaApollo(db, {
      limit,
      ...(tagFilter ? { tagFilter } : {}),
      ...(countryFilter ? { countryFilter } : {}),
      ...(staleHours != null ? { staleHours } : {}),
    });
    totalProcessed += result.processed;
    totalMatched += result.matched;
    totalUnmatched += result.unmatched;
    const degradeNote = result.firstDegradeReason
      ? ` degrade="${result.firstDegradeReason}"`
      : '';
    console.log(
      `[ke-apollo] iter — processed=${result.processed} matched=${result.matched} unmatched=${result.unmatched} errors=${result.errors} remaining=${result.remaining} apolloCalls=${result.apolloCalls}${degradeNote}`,
    );

    const madeProgress = result.matched > 0 || result.unmatched > 0;
    if (!madeProgress) {
      noProgressIterations += 1;
      if (noProgressIterations >= 3) {
        console.warn(
          `\n[ke-apollo] stopping — 3 consecutive iterations made no progress (rate-limited or degraded). Re-run later to resume; idempotent on apollo_synced_at.`,
        );
        break;
      }
      const backoffMs = 60_000 * Math.pow(2, noProgressIterations - 1);
      console.log(
        `[ke-apollo] backing off ${Math.round(backoffMs / 1000)}s before next iter…`,
      );
      await new Promise((r) => setTimeout(r, backoffMs));
    } else {
      noProgressIterations = 0;
    }
    if (result.remaining === 0) break;
  }

  console.log(
    `\n[ke-apollo] done — total processed=${totalProcessed} matched=${totalMatched} unmatched=${totalUnmatched}`,
  );
  console.log(
    `[ke-apollo] entities with primary_domain populated are now ready for the crawler:\n    pnpm --filter @procur/ai crawl-entity-website --tag=${tagFilter ?? '<your-tag>'}`,
  );
}

main().catch((err) => {
  console.error('[ke-apollo] FAILED', err);
  process.exit(1);
});
