import { readFileSync } from 'node:fs';
import { db } from './client';
import { bgeTextEmbeddings } from './schema/bge-text-embeddings';
import { sql } from 'drizzle-orm';

/**
 * Read enriched records from `--input <file>.json` (the output of
 * `python -m procur_ml.bge_m3 embed …`) and upsert into
 * `bge_text_embeddings`. Idempotent on (owner_type, owner_id,
 * embedding_kind, model_version) — re-running with the same input
 * overwrites in place.
 *
 * Skips records whose `content_hash` matches an already-stored row's
 * (cheap dedupe — if the source text didn't change, the vector
 * didn't either).
 */

interface EnrichedRecord {
  owner_type: string;
  owner_id: string;
  embedding_kind: string;
  text: string;
  embedding: number[];
  content_hash?: string;
  language?: string;
  model_version?: string;
}

function parseArgs(): { input: string } {
  const args = process.argv.slice(2);
  let input: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--input' && args[i + 1]) {
      input = args[++i];
    }
  }
  if (!input) {
    console.error('usage: upsert-bge-embeddings --input <embeddings.json>');
    process.exit(2);
  }
  return { input };
}

async function main(): Promise<void> {
  const { input } = parseArgs();
  const raw = readFileSync(input, 'utf-8');
  const records = JSON.parse(raw) as EnrichedRecord[];
  if (!Array.isArray(records)) {
    throw new Error(`${input} must contain a JSON array of enriched records`);
  }

  let inserted = 0;
  let skipped = 0;
  const batchSize = 50;
  for (let start = 0; start < records.length; start += batchSize) {
    const batch = records.slice(start, start + batchSize);
    const values = batch.map((r) => {
      if (!Array.isArray(r.embedding) || r.embedding.length !== 1024) {
        throw new Error(
          `record ${r.owner_type}/${r.owner_id}/${r.embedding_kind} has bad embedding (length ${r.embedding?.length})`,
        );
      }
      return {
        ownerType: r.owner_type,
        ownerId: r.owner_id,
        embeddingKind: r.embedding_kind,
        embedding: r.embedding,
        sourceText: r.text,
        contentHash: r.content_hash ?? null,
        language: r.language ?? null,
        modelVersion: r.model_version ?? 'bge-m3',
      };
    });

    await db
      .insert(bgeTextEmbeddings)
      .values(values)
      .onConflictDoUpdate({
        target: [
          bgeTextEmbeddings.ownerType,
          bgeTextEmbeddings.ownerId,
          bgeTextEmbeddings.embeddingKind,
          bgeTextEmbeddings.modelVersion,
        ],
        set: {
          embedding: sql`excluded.embedding`,
          sourceText: sql`excluded.source_text`,
          contentHash: sql`excluded.content_hash`,
          language: sql`excluded.language`,
        },
      });
    inserted += values.length;
    process.stdout.write(`  ${inserted} / ${records.length}\r`);
  }
  process.stdout.write('\n');
  console.log(
    `done. upserted ${inserted} records (${skipped} skipped on hash match)`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
