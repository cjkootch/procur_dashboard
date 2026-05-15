/**
 * USDA FSIS MPI → rolodex + website-intel pipeline — local CLI.
 *
 * Loops `promoteAndCrawlMpiEstablishments` until either all eligible
 * rows are processed (remaining=0) or two empty iterations in a row.
 *
 * Run from repo root:
 *   pnpm --filter @procur/ai intel-mpi
 *
 * Env:
 *   DATABASE_URL                       # required
 *   ANTHROPIC_API_KEY                  # required when MPI_INTEL_CRAWL=1
 *   BLOB_READ_WRITE_TOKEN              # optional (crawler caches PDFs)
 *   MPI_INTEL_BATCH_SIZE=25            # rows per loop iteration
 *   MPI_INTEL_CRAWL=1                  # fire website crawl in same pass; defaults to 1
 *   MPI_INTEL_SPECIES_FILTER=swine     # filter eligible rows by species
 *   MPI_INTEL_SIZE_FILTER=Large,Small  # filter eligible rows by FSIS size_class
 *                                        (e.g. 'Large,Small' skips 'Very Small')
 */
import 'dotenv/config';
import { config as loadEnv } from 'dotenv';
import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import * as schema from '@procur/db';
import { promoteAndCrawlMpiEstablishments } from '../usda-fsis-rolodex-pipeline';

loadEnv({ path: '../../.env.local' });
loadEnv({ path: '../../.env' });

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
  const db = drizzle(neon(process.env.DATABASE_URL), { schema });

  const limit = Number.parseInt(process.env.MPI_INTEL_BATCH_SIZE ?? '25', 10);
  const crawl = process.env.MPI_INTEL_CRAWL !== '0';
  const speciesFilter = process.env.MPI_INTEL_SPECIES_FILTER;
  const sizeClassFilter = process.env.MPI_INTEL_SIZE_FILTER?.split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  console.log(
    `[mpi-intel] starting — batch=${limit} crawl=${crawl}${speciesFilter ? ` species=${speciesFilter}` : ''}${sizeClassFilter && sizeClassFilter.length > 0 ? ` size=${sizeClassFilter.join('|')}` : ''}`,
  );

  let totalPromoted = 0;
  let totalCrawled = 0;
  let consecutiveEmpty = 0;

  while (true) {
    const result = await promoteAndCrawlMpiEstablishments(db, {
      limit,
      crawl,
      ...(speciesFilter ? { speciesFilter } : {}),
      ...(sizeClassFilter && sizeClassFilter.length > 0 ? { sizeClassFilter } : {}),
    });
    totalPromoted += result.promoted;
    totalCrawled += result.crawled;
    console.log(
      `[mpi-intel] iter — processed=${result.processed} promoted=${result.promoted} crawled=${result.crawled} crawlErrors=${result.crawlErrors} errors=${result.errors} remaining=${result.remaining}`,
    );
    if (result.processed === 0) {
      consecutiveEmpty += 1;
      if (consecutiveEmpty >= 2) break;
    } else {
      consecutiveEmpty = 0;
    }
    if (result.remaining === 0) break;
  }

  console.log(
    `\n[mpi-intel] done — total promoted=${totalPromoted} crawled=${totalCrawled}`,
  );
}

main().catch((err) => {
  console.error('[mpi-intel] FAILED', err);
  process.exit(1);
});
