/**
 * USDA FSIS MPI Directory ingest — local CLI wrapper.
 *
 * Pulls the latest Meat, Poultry and Egg Product Inspection Directory
 * CSV from FSIS and upserts it into `usda_fsis_establishments`.
 *
 * Idempotent on establishment_number. Re-running updates mutable
 * fields but never resets enrichment columns (apollo_org_id,
 * capacity_*, product_*) which are owned by separate pipelines.
 *
 * Run from repo root:
 *   pnpm --filter @procur/db ingest-usda-fsis-mpi
 *
 * Env:
 *   DATABASE_URL              # required
 *   MPI_CSV_URL               # optional override; auto-discovered from
 *                             # the FSIS catalog page when unset
 */
import 'dotenv/config';
import { config as loadEnv } from 'dotenv';
import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import * as schema from './schema';
import { fetchAndIngestMpiDirectory } from './lib/usda-fsis-mpi';

loadEnv({ path: '../../.env.local' });
loadEnv({ path: '../../.env' });

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required.');
  }
  const db = drizzle(neon(process.env.DATABASE_URL), { schema });

  const result = await fetchAndIngestMpiDirectory(db);

  console.log(
    `\n[fsis-mpi] done — csv=${result.csvUrl} parsed=${result.rowsParsed} upserted=${result.rowsUpdated} skipped=${result.rowsSkipped} errors=${result.errors}`,
  );
}

main().catch((err) => {
  console.error('[fsis-mpi] FAILED', err);
  process.exit(1);
});
