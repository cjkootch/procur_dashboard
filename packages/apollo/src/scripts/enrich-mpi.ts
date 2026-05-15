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
  let noProgressIterations = 0;

  while (true) {
    const result = await enrichMpiEstablishmentsViaApollo(db, {
      limit,
      ...(speciesFilter ? { speciesFilter } : {}),
      ...(staleHours != null ? { staleHours } : {}),
    });
    totalProcessed += result.processed;
    totalMatched += result.matched;
    totalUnmatched += result.unmatched;
    const degradeNote = result.firstDegradeReason
      ? ` degrade="${result.firstDegradeReason}"`
      : '';
    console.log(
      `[fsis-apollo] iter — processed=${result.processed} matched=${result.matched} unmatched=${result.unmatched} errors=${result.errors} remaining=${result.remaining} apolloCalls=${result.apolloCalls}${degradeNote}`,
    );

    // Progress check: "no progress" means nothing got matched OR
    // newly stamped as unmatched this iter. Pure-error iterations
    // count as no-progress so we don't loop forever burning Apollo
    // calls when the API is rate-limiting us.
    const madeProgress = result.matched > 0 || result.unmatched > 0;
    if (!madeProgress) {
      noProgressIterations += 1;
      if (noProgressIterations >= 3) {
        console.warn(
          `\n[fsis-apollo] stopping — 3 consecutive iterations made no progress (Apollo rate-limiting or degraded). Re-run later to resume; idempotent on apollo_synced_at.`,
        );
        break;
      }
      // Exponential backoff: 60s, 120s, 240s.
      const backoffMs = 60_000 * Math.pow(2, noProgressIterations - 1);
      console.log(
        `[fsis-apollo] backing off ${Math.round(backoffMs / 1000)}s before next iter…`,
      );
      await new Promise((r) => setTimeout(r, backoffMs));
    } else {
      noProgressIterations = 0;
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
