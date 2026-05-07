import 'server-only';
import { and, desc, eq, sql } from 'drizzle-orm';
import {
  bgeTextEmbeddings,
  db,
  type BgeOwnerType,
  type BgeTextEmbedding,
} from '@procur/db';

/**
 * Read/write helpers for the BGE-M3 multilingual text-embedding
 * layer. Companion to the OpenAI-flavored helpers in
 * `entity-text-embeddings.ts` — same shape, different vector space.
 *
 * Discipline: callers MUST pass a query embedding produced by the
 * SAME model they're searching against. A `bge-m3` query against
 * `entity_text_embeddings` (or vice-versa) is a category error and
 * returns garbage similarity scores.
 *
 * The Python producer in `services/ml-training/procur_ml/bge_m3.py`
 * generates the embeddings; this layer only reads/writes rows.
 */

export interface BgeSearchHit {
  id: string;
  ownerType: string;
  ownerId: string;
  embeddingKind: string;
  sourceText: string;
  language: string | null;
  modelVersion: string;
  similarity: number;
}

/**
 * Cosine-similarity search across BGE-M3 embeddings, optionally
 * scoped by owner_type / embedding_kind / language. Returns rows
 * ordered by similarity (1 = identical, 0 = orthogonal, -1 = opposite).
 *
 * `queryEmbedding` MUST be a 1024-dim vector produced by the same
 * `bge-m3` checkpoint that produced the stored rows.
 */
export async function findByBgeText(input: {
  queryEmbedding: number[];
  ownerType?: BgeOwnerType | string;
  embeddingKind?: string;
  language?: string;
  modelVersion?: string;
  limit?: number;
}): Promise<BgeSearchHit[]> {
  if (input.queryEmbedding.length !== 1024) {
    throw new Error(
      `BGE-M3 query embedding must be 1024-dim; got ${input.queryEmbedding.length}.`,
    );
  }
  const limit = input.limit ?? 20;
  const vectorLiteral = `[${input.queryEmbedding.join(',')}]`;
  const filters = [
    input.ownerType ? eq(bgeTextEmbeddings.ownerType, input.ownerType) : null,
    input.embeddingKind
      ? eq(bgeTextEmbeddings.embeddingKind, input.embeddingKind)
      : null,
    input.language ? eq(bgeTextEmbeddings.language, input.language) : null,
    input.modelVersion
      ? eq(bgeTextEmbeddings.modelVersion, input.modelVersion)
      : null,
  ].filter(Boolean);

  const rows = await db
    .select({
      id: bgeTextEmbeddings.id,
      ownerType: bgeTextEmbeddings.ownerType,
      ownerId: bgeTextEmbeddings.ownerId,
      embeddingKind: bgeTextEmbeddings.embeddingKind,
      sourceText: bgeTextEmbeddings.sourceText,
      language: bgeTextEmbeddings.language,
      modelVersion: bgeTextEmbeddings.modelVersion,
      // 1 - cosine_distance gives similarity in [-1, 1]; HNSW index
      // serves the order, this expression just flips the sign for
      // human-readable output.
      similarity: sql<number>`1 - (${bgeTextEmbeddings.embedding} <=> ${vectorLiteral}::vector)`,
    })
    .from(bgeTextEmbeddings)
    .where(filters.length > 0 ? and(...(filters as never[])) : undefined)
    .orderBy(sql`${bgeTextEmbeddings.embedding} <=> ${vectorLiteral}::vector`)
    .limit(limit);
  return rows as BgeSearchHit[];
}

/**
 * Idempotent upsert keyed on (owner_type, owner_id, embedding_kind,
 * model_version). Producers compute embeddings out-of-process (the
 * Python BGE-M3 module) and feed the rows back through here.
 */
export async function upsertBgeEmbedding(input: {
  ownerType: BgeOwnerType | string;
  ownerId: string;
  embeddingKind: string;
  embedding: number[];
  sourceText: string;
  contentHash?: string | null;
  language?: string | null;
  modelVersion?: string;
}): Promise<void> {
  if (input.embedding.length !== 1024) {
    throw new Error(
      `BGE-M3 embedding must be 1024-dim; got ${input.embedding.length}.`,
    );
  }
  const modelVersion = input.modelVersion ?? 'bge-m3';
  const values = {
    ownerType: input.ownerType,
    ownerId: input.ownerId,
    embeddingKind: input.embeddingKind,
    embedding: input.embedding,
    sourceText: input.sourceText,
    contentHash: input.contentHash ?? null,
    language: input.language ?? null,
    modelVersion,
  };
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
        embedding: values.embedding,
        sourceText: values.sourceText,
        contentHash: values.contentHash,
        language: values.language,
      },
    });
}

/**
 * List existing rows for an owner — useful for the producer's "skip
 * re-embedding when hash matches" check.
 */
export async function listBgeEmbeddingsForOwner(input: {
  ownerType: BgeOwnerType | string;
  ownerId: string;
  modelVersion?: string;
}): Promise<BgeTextEmbedding[]> {
  const modelVersion = input.modelVersion ?? 'bge-m3';
  return db
    .select()
    .from(bgeTextEmbeddings)
    .where(
      and(
        eq(bgeTextEmbeddings.ownerType, input.ownerType),
        eq(bgeTextEmbeddings.ownerId, input.ownerId),
        eq(bgeTextEmbeddings.modelVersion, modelVersion),
      ),
    )
    .orderBy(desc(bgeTextEmbeddings.createdAt));
}
