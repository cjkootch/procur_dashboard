/**
 * Backfill text embeddings for known_entities — Component D
 * mention-resolution foundation per docs/procur-ml-layer-brief.md §7.1.
 *
 * Embeds each entity's combined identity text (name + aliases +
 * categories + first 500 chars of notes) using
 * text-embedding-3-small (procur's standard 1536d). Result lands in
 * entity_text_embeddings; queryable via findEntitiesByText.
 *
 * Cost: ~5K entities × ~150 tokens average ≈ 750K tokens ≈ $0.015 at
 * current pricing. Trivial for a one-shot backfill; safe to re-run.
 *
 * Idempotent: ON CONFLICT (entity_slug, embedding_kind, model_version)
 * DO UPDATE — bumping the model creates new rows; same model overwrites.
 *
 * Run from repo root:
 *   pnpm --filter @procur/ai seed-entity-text-embeddings
 *   pnpm --filter @procur/ai seed-entity-text-embeddings --country=JM
 *   pnpm --filter @procur/ai seed-entity-text-embeddings --dry-run
 */
import 'dotenv/config';
import { config as loadEnv } from 'dotenv';
import { sql } from 'drizzle-orm';
import { db } from '@procur/db/client';
import { embedMany, EMBEDDING_MODEL } from './embeddings';

loadEnv({ path: '../../.env.local' });
loadEnv({ path: '../../.env' });

const EMBEDDING_KIND = 'combined_v1';
const BATCH_SIZE = 100; // text-embedding-3-small accepts up to 2048 inputs/req; 100 keeps memory bounded

type EntityRow = {
  slug: string;
  name: string;
  country: string;
  role: string;
  categories: string[] | null;
  aliases: string[] | null;
  notes: string | null;
};

function composeSourceText(e: EntityRow): string {
  const parts: string[] = [e.name];
  if (e.aliases && e.aliases.length > 0) {
    parts.push(`aka: ${e.aliases.join(', ')}`);
  }
  parts.push(`country: ${e.country}`);
  parts.push(`role: ${e.role}`);
  if (e.categories && e.categories.length > 0) {
    parts.push(`categories: ${e.categories.join(', ')}`);
  }
  if (e.notes) {
    parts.push(e.notes.slice(0, 500));
  }
  return parts.join('\n');
}

function _vectorLiteral(values: number[]): string {
  return `[${values.map((v) => v.toFixed(8)).join(',')}]`;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const countryArg = args.find((a) => a.startsWith('--country='));
  const country = countryArg
    ? (countryArg.split('=')[1] ?? '').toUpperCase() || null
    : null;

  console.log(
    `seed-entity-text-embeddings — model=${EMBEDDING_MODEL}, kind=${EMBEDDING_KIND}, country=${country ?? 'ALL'}, dryRun=${dryRun}`,
  );

  // neon-http db.execute returns `{ rows, rowCount }`; cast the
  // .rows accessor, not the result wrapper.
  const result = await (country
    ? db.execute(sql`
        SELECT slug, name, country, role, categories, aliases, notes
          FROM known_entities
         WHERE country = ${country}
      `)
    : db.execute(sql`
        SELECT slug, name, country, role, categories, aliases, notes
          FROM known_entities
      `));
  const rows = result.rows as unknown as EntityRow[];

  console.log(`  loaded ${rows.length} entities`);
  if (rows.length === 0) {
    console.log('nothing to embed.');
    return;
  }

  if (dryRun) {
    console.log('  preview (first 5 source-text compositions):');
    for (const e of rows.slice(0, 5)) {
      console.log(`    ${e.slug}:`);
      for (const line of composeSourceText(e).split('\n')) {
        console.log(`      ${line}`);
      }
    }
    console.log('\n(dry run — no embeddings called or rows written.)');
    return;
  }

  let inserted = 0;
  let errors = 0;

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const sources = batch.map(composeSourceText);
    let vectors: number[][];
    try {
      vectors = await embedMany(sources);
    } catch (err) {
      errors += batch.length;
      console.error(`  batch ${i / BATCH_SIZE + 1} failed: ${(err as Error).message}`);
      continue;
    }
    if (vectors.length !== batch.length) {
      errors += batch.length;
      console.error(`  batch returned ${vectors.length} vectors for ${batch.length} entities — skipping`);
      continue;
    }

    for (let j = 0; j < batch.length; j += 1) {
      const e = batch[j];
      const vec = vectors[j];
      if (!e || !vec) continue;
      try {
        await db.execute(sql`
          INSERT INTO entity_text_embeddings (
            entity_slug, embedding_kind, embedding, source_text, model_version
          ) VALUES (
            ${e.slug},
            ${EMBEDDING_KIND},
            ${_vectorLiteral(vec)}::vector,
            ${sources[j] ?? composeSourceText(e)},
            ${EMBEDDING_MODEL}
          )
          ON CONFLICT (entity_slug, embedding_kind, model_version)
          DO UPDATE SET
            embedding = EXCLUDED.embedding,
            source_text = EXCLUDED.source_text,
            created_at = now();
        `);
        inserted += 1;
      } catch (err) {
        errors += 1;
        console.error(`  ${e.slug}: ${(err as Error).message}`);
      }
    }
    console.log(`  batch ${i / BATCH_SIZE + 1}/${Math.ceil(rows.length / BATCH_SIZE)} done — ${inserted} inserted, ${errors} errors`);
  }

  console.log(`\nDone. inserted=${inserted}, errors=${errors}`);
  if (errors > 0) process.exit(1);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
