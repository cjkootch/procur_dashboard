import { readFileSync } from 'node:fs';
import { db } from './client';
import {
  extractedEntities,
  type NewExtractedEntity,
} from './schema/extracted-entities';

/**
 * Read the JSON output of `python -m procur_ml.gliner_extract extract`
 * and upsert into `extracted_entities`. Idempotent on the partial
 * unique index in migration 0088 — re-running with the same input
 * is a no-op (rows match the unique key, ON CONFLICT DO NOTHING).
 *
 * Each record in the input has shape:
 *   {
 *     source_type: 'message' | 'document' | …,
 *     source_id: string,
 *     text: string,
 *     spans: [{ label, value, start, end, confidence }],
 *     model_version: string,
 *   }
 */

interface InputRecord {
  source_type: string;
  source_id: string;
  text?: string;
  model_version?: string;
  spans: Array<{
    label: string;
    value: string;
    start?: number | null;
    end?: number | null;
    confidence?: number | null;
  }>;
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
    console.error('usage: upsert-gliner-spans --input <spans.json>');
    process.exit(2);
  }
  return { input };
}

async function main(): Promise<void> {
  const { input } = parseArgs();
  const raw = readFileSync(input, 'utf-8');
  const records = JSON.parse(raw) as InputRecord[];
  if (!Array.isArray(records)) {
    throw new Error(`${input} must contain a JSON array`);
  }

  let totalSpans = 0;
  const batchSize = 200;
  const flat: NewExtractedEntity[] = [];

  for (const r of records) {
    if (!Array.isArray(r.spans)) continue;
    const modelVersion = r.model_version ?? 'gliner-multitask-v1';
    for (const s of r.spans) {
      if (!s.label || !s.value) continue;
      flat.push({
        sourceType: r.source_type,
        sourceId: r.source_id,
        label: s.label,
        value: s.value,
        startOffset: typeof s.start === 'number' ? s.start : null,
        endOffset: typeof s.end === 'number' ? s.end : null,
        confidence:
          typeof s.confidence === 'number' ? String(s.confidence) : null,
        modelVersion,
      });
    }
  }

  console.log(
    `flattened ${records.length} records into ${flat.length} spans`,
  );

  for (let start = 0; start < flat.length; start += batchSize) {
    const batch = flat.slice(start, start + batchSize);
    await db.insert(extractedEntities).values(batch).onConflictDoNothing();
    totalSpans += batch.length;
    process.stdout.write(`  ${totalSpans} / ${flat.length}\r`);
  }
  process.stdout.write('\n');
  console.log(`done. upserted ${totalSpans} spans (dupes skipped)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
