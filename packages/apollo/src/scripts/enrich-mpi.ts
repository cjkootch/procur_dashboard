/**
 * Apollo enrichment for USDA FSIS MPI establishments — local CLI wrapper.
 *
 * Loops `enrichMpiEstablishmentsViaApollo` until either:
 *   - All pending rows are processed (remaining=0)
 *   - Apollo returns enough errors in a row that further calls would
 *     be wasteful (5 consecutive errors)
 *
 * Idempotent on `apollo_synced_at`. Re-running with `--stale-hours=N`
 * forces refresh of rows older than N hours.
 *
 * Run from repo root:
 *   pnpm --filter @procur/db enrich-usda-fsis-apollo
 *
 * Env:
 *   DATABASE_URL                       # required
 *   APOLLO_API_KEY                     # required (apollo client)
 *   MPI_APOLLO_BATCH_SIZE=200          # rows per loop iteration
 *   MPI_APOLLO_SPECIES_FILTER=swine    # optional; e.g. enrich just pork first
 *   MPI_APOLLO_STALE_HOURS=720         # optional; refresh rows older than this
 */
import 'dotenv/config';
import { config as loadEnv } from 'dotenv';
import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import * as schema from '@procur/db';
import { enrichMpiEstablishmentsViaApollo } from '../usda-fsis-mpi-enrich';

loadEnv({ path: '../../.env.local' });
loadEnv({ path: '../../.env' });

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required.');
  }
  const db = drizzle(neon(process.env.DATABASE_URL), { schema });
  const limit = Number.parseInt(
    process.env.MPI_APOLLO_BATCH_SIZE ?? '200',
    10,
  );
  const speciesFilter = process.env.MPI_APOLLO_SPECIES_FILTER;
  const staleHoursRaw = process.env.MPI_APOLLO_STALE_HOURS;
  const staleHours = staleHoursRaw
    ? Number.parseInt(staleHoursRaw, 10)
    : undefined;

  console.log(
    `[fsis-apollo] starting — batch=${limit}${speciesFilter ? ` species=${speciesFilter}` : ''}${staleHours ? ` staleHours=${staleHours}` : ''}`,
  );

  let totalProcessed = 0;
  let totalMatched = 0;
  let totalUnmatched = 0;
  let consecutiveEmptyIterations = 0;

  while (true) {
    const result = await enrichMpiEstablishmentsViaApollo(db, {
      limit,
      ...(speciesFilter ? { speciesFilter } : {}),
      ...(staleHours != null ? { staleHours } : {}),
    });
    totalProcessed += result.processed;
    totalMatched += result.matched;
    totalUnmatched += result.unmatched;
    console.log(
      `[fsis-apollo] iter — processed=${result.processed} matched=${result.matched} unmatched=${result.unmatched} errors=${result.errors} remaining=${result.remaining} apolloCalls=${result.apolloCalls}`,
    );
    if (result.processed === 0) {
      consecutiveEmptyIterations += 1;
      if (consecutiveEmptyIterations >= 2) break;
    } else {
      consecutiveEmptyIterations = 0;
    }
    if (result.remaining === 0) break;
  }

  console.log(
    `\n[fsis-apollo] done — total processed=${totalProcessed} matched=${totalMatched} unmatched=${totalUnmatched}`,
  );
}

main().catch((err) => {
  console.error('[fsis-apollo] FAILED', err);
  process.exit(1);
});
