/**
 * Global Energy Monitor — Global Energy Ownership Tracker (GEOT) ingest.
 *
 * Source: GEM Trackers hub (download requires their data-request form)
 * License: CC-BY-4.0
 * Coverage: ~26K corporate ownership relationships (subject → parent).
 *
 * We ingest the "Entity Ownership" sheet only — that's the highest-
 * leverage slice for the supplier-graph workflow. Asset-level ownership
 * (50K rows in a sibling sheet) duplicates info already captured by
 * each known_entity's `metadata.operator` / `metadata.parent_companies`.
 *
 * What this enables:
 *   "Eni Sannazzaro Refinery → operator Eni S.p.A. → 30% Italian govt,
 *    70% public" walks correctly. State-owned vs publicly-held
 *    operators have very different deal mechanics.
 *
 * Run: pnpm --filter @procur/db ingest-gem-ownership <path-to-geot-xlsx>
 */
import 'dotenv/config';
import { config as loadEnv } from 'dotenv';
import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import * as schema from './schema';
import { readTabular, pickCol, parseNumberSafe } from './lib/read-tabular';

loadEnv({ path: '../../.env.local' });
loadEnv({ path: '../../.env' });

const SOURCE = 'gem-geot';
const SHEET_NAME = 'Entity Ownership';

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set');

  const path = process.argv[2] ?? process.env.GEM_GEOT_PATH;
  if (!path) {
    console.error(
      'Usage: pnpm --filter @procur/db ingest-gem-ownership <path-to-geot.xlsx>\n' +
        'Or set GEM_GEOT_PATH env var.',
    );
    process.exit(1);
  }

  console.log(`Reading GEOT "${SHEET_NAME}" sheet from ${path}...`);
  const rows = await readTabular(path, SHEET_NAME);
  console.log(`  ${rows.length} ownership relationships`);

  const client = neon(url);
  const db = drizzle(client, { schema, casing: 'snake_case' });

  let upserted = 0;
  let skipped = 0;

  // Insert in chunks of 500 to stay under neon-http's transaction limits.
  const CHUNK_SIZE = 500;
  const valid: schema.NewEntityOwnership[] = [];
  for (const row of rows) {
    const subjectGemId = pickCol(row, 'Subject Entity ID');
    const subjectName = pickCol(row, 'Subject Entity Name');
    const parentGemId = pickCol(row, 'Interested Party ID');
    const parentName = pickCol(row, 'Interested Party Name');
    if (!subjectGemId || !subjectName || !parentGemId || !parentName) {
      skipped += 1;
      continue;
    }
    const sharePct = parseNumberSafe(pickCol(row, '% Share of Ownership'));
    const shareImputedRaw = (pickCol(row, 'Share Imputed?') ?? '').toLowerCase();
    const shareImputed = shareImputedRaw.includes('imputed') && !shareImputedRaw.includes('not imputed');
    const sourceUrls = pickCol(row, 'Data Source URL');

    valid.push({
      source: SOURCE,
      subjectGemId,
      subjectName,
      parentGemId,
      parentName,
      sharePct: sharePct != null ? String(sharePct) : null,
      shareImputed,
      sourceUrls,
    });
  }

  console.log(`  ${valid.length} valid rows, ${skipped} skipped (missing required fields)`);
  console.log(`Upserting in chunks of ${CHUNK_SIZE}...`);

  for (let i = 0; i < valid.length; i += CHUNK_SIZE) {
    const chunk = valid.slice(i, i + CHUNK_SIZE);
    await db
      .insert(schema.entityOwnership)
      .values(chunk)
      .onConflictDoUpdate({
        target: [
          schema.entityOwnership.source,
          schema.entityOwnership.subjectGemId,
          schema.entityOwnership.parentGemId,
        ],
        set: {
          subjectName: schema.entityOwnership.subjectName,
          parentName: schema.entityOwnership.parentName,
          sharePct: schema.entityOwnership.sharePct,
          shareImputed: schema.entityOwnership.shareImputed,
          sourceUrls: schema.entityOwnership.sourceUrls,
          updatedAt: new Date(),
        },
      });
    upserted += chunk.length;
    if ((i / CHUNK_SIZE) % 5 === 0) {
      console.log(`  ${upserted}/${valid.length}...`);
    }
  }

  console.log(`Done. upserted=${upserted}, skipped=${skipped}.`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
