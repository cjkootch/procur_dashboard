/**
 * One-shot cleanup for refinery rows that got polluted with power-plant
 * metadata before the matcher was made role-aware.
 *
 * Background: an early version of `findOrUpsertEntity` matched purely on
 * (country + name trigram ≥ 0.55). When the GOGPT (Global Oil & Gas
 * Plant Tracker) ingest ran for the first time, 581 of its candidates
 * fuzzy-matched into existing refinery / producer rows that happened to
 * share a name fragment ("Eni Sannazzaro Refinery" vs "Eni Sannazzaro
 * Power Plant"), and those rows ended up with power-plant tags and
 * `capacity_mw` / `unit_count` / `start_year` / `fuels` / `statuses`
 * fields layered onto refinery records.
 *
 * The matcher is now role-aware (see find-or-upsert-entity.ts), but the
 * already-merged rows need to be repaired:
 *
 *   1. This script strips the GOGPT-injected fields and tags from any
 *      row whose role is NOT 'power-plant'.
 *   2. After running this, re-run `ingest-gem-power-plants` — the new
 *      role-aware matcher will treat every plant as a fresh insert
 *      (since no power-plant row exists yet) and create proper rows.
 *
 * Run:
 *   pnpm --filter @procur/db cleanup-cross-role-merges
 *   pnpm --filter @procur/db cleanup-cross-role-merges --dry-run
 */
import 'dotenv/config';
import { config as loadEnv } from 'dotenv';
import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import { sql } from 'drizzle-orm';
import * as schema from './schema';

loadEnv({ path: '../../.env.local' });
loadEnv({ path: '../../.env' });

// Tags only ever emitted by ingest-gem-power-plants.ts.
const POWER_PLANT_TAGS = ['power-plant', 'fuel:dual', 'fuel:oil', 'fuel:gas'];

// Metadata keys only ever written by ingest-gem-power-plants.ts.
const POWER_PLANT_META_KEYS = [
  'capacity_mw',
  'unit_count',
  'start_year',
  'fuels',
  'statuses',
];

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL not set');
  const client = neon(databaseUrl);
  const db = drizzle(client, { schema });

  const candidates = await db.execute(sql`
    SELECT slug, name, country, role, tags, metadata
    FROM known_entities
    WHERE role <> 'power-plant'
      AND metadata ? 'capacity_mw'
    ORDER BY country, name;
  `);

  const rows = candidates.rows as Array<{
    slug: string;
    name: string;
    country: string;
    role: string;
    tags: string[] | null;
    metadata: Record<string, unknown> | null;
  }>;

  console.log(`Found ${rows.length} cross-role-merged rows to repair.`);
  if (dryRun) {
    for (const r of rows.slice(0, 20)) {
      console.log(`  - [${r.country}] ${r.name} (role=${r.role})`);
    }
    if (rows.length > 20) console.log(`  ... and ${rows.length - 20} more`);
    console.log('Dry run — no writes.');
    return;
  }

  let cleaned = 0;
  for (const r of rows) {
    const newTags = (r.tags ?? []).filter(
      (t) => !POWER_PLANT_TAGS.includes(t),
    );
    const newMeta: Record<string, unknown> = { ...(r.metadata ?? {}) };
    for (const k of POWER_PLANT_META_KEYS) delete newMeta[k];

    await db
      .update(schema.knownEntities)
      .set({
        tags: newTags,
        metadata: newMeta,
        updatedAt: new Date(),
      })
      .where(sql`slug = ${r.slug}`);
    cleaned++;
  }

  console.log(`Cleaned ${cleaned} rows.`);
  console.log(
    'Next: re-run `pnpm --filter @procur/db ingest-gem-power-plants <path>` ' +
      'to create proper power-plant rows for those plants.',
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
