import {
  pgTable,
  uuid,
  text,
  timestamp,
  vector,
  index,
  unique,
} from 'drizzle-orm/pg-core';

/**
 * Text embeddings for entity-mention resolution.
 * Per docs/procur-ml-layer-brief.md §7.1 (Component D).
 *
 * Distinct from entity_embeddings (Component A — 128d graph embeddings):
 *   - graph embeddings → structural similarity (counterparty co-occurrence)
 *   - text embeddings  → name/description similarity (mention matching)
 *
 * 1536 dims matches text-embedding-3-small, procur's standard text
 * embedding model (also used by past_performance + content_library).
 */
export const entityTextEmbeddings = pgTable(
  'entity_text_embeddings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Same canonical-key shape getEntityProfile uses. */
    entitySlug: text('entity_slug').notNull(),
    /** 'name' | 'name_plus_aliases' | 'name_plus_categories' |
        'combined_v1' — free text, new compositions slot in without
        migration. */
    embeddingKind: text('embedding_kind').notNull(),
    embedding: vector('embedding', { dimensions: 1536 }).notNull(),
    /** What text was embedded — audit trail for "why this match". */
    sourceText: text('source_text').notNull(),
    /** Embedding model identifier (e.g. 'text-embedding-3-small'). */
    modelVersion: text('model_version').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => ({
    slugIdx: index('entity_text_embeddings_slug_idx').on(table.entitySlug),
    kindIdx: index('entity_text_embeddings_kind_idx').on(table.embeddingKind),
    hnswIdx: index('entity_text_embeddings_hnsw_idx')
      .using('hnsw', table.embedding.op('vector_cosine_ops')),
    uniqByModel: unique().on(
      table.entitySlug,
      table.embeddingKind,
      table.modelVersion,
    ),
  }),
);

export type EntityTextEmbedding = typeof entityTextEmbeddings.$inferSelect;
export type NewEntityTextEmbedding = typeof entityTextEmbeddings.$inferInsert;
