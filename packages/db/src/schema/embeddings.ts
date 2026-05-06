import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  vector,
  index,
  unique,
} from 'drizzle-orm/pg-core';

/**
 * ML Layer Phase 1, Component A — vector store for graph embeddings.
 * Per docs/procur-ml-layer-brief.md §4. Foundation for the GraphSAGE
 * training pipeline (Component B), two-tower retrieval (Component C),
 * and entity resolution (Component D).
 *
 * Why 128 dims and separate from the existing 1536-dim past_performance
 * + content_library text-embedding columns: graph embeddings live in
 * a denser structural space. PinSage uses 128, GraphSAGE is flexible,
 * brief recommends 128 as starting point. Mixing 128-dim graph and
 * 1536-dim text embeddings in the same similarity calc would be
 * meaningless; keep separate spaces.
 *
 * Multiple embedding_kind per entity is intentional — graph_v1 from
 * Component B, attribute_v1 from text/structured features, and a
 * combined_v1 production-retrieval embedding stay queryable side-by-
 * side for debugging + A/B testing.
 *
 * pgvector + HNSW are already enabled procur-wide via
 * bootstrap.ts/migrate.ts.
 */
export const entityEmbeddings = pgTable(
  'entity_embeddings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Same canonical-key shape getEntityProfile + fuel_consumption_signals
        use — accepts known_entities.slug or external_suppliers.id. */
    entitySlug: text('entity_slug').notNull(),
    /** 'graph_v1' | 'attribute_v1' | 'combined_v1' — free text so new
        kinds slot in without migration. */
    embeddingKind: text('embedding_kind').notNull(),
    embedding: vector('embedding', { dimensions: 128 }).notNull(),
    /** Sanity check guard against a future dim change while old
        rows persist. */
    embeddingDim: integer('embedding_dim').notNull().default(128),
    /** Identifier of the model that produced this row, e.g.
        'graphsage_2026_05_v1'. Lets retrieval prefer the latest. */
    modelVersion: text('model_version').notNull(),
    /** When the producing model was trained — distinct from
        createdAt for "embeddings older than N days are stale" queries. */
    trainedAt: timestamp('trained_at').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => ({
    slugIdx: index('entity_embeddings_slug_idx').on(table.entitySlug),
    kindIdx: index('entity_embeddings_kind_idx').on(table.embeddingKind),
    modelVersionIdx: index('entity_embeddings_model_version_idx').on(table.modelVersion),
    // HNSW with cosine distance — production standard for ANN.
    hnswIdx: index('entity_embeddings_hnsw_idx')
      .using('hnsw', table.embedding.op('vector_cosine_ops')),
    uniqByModel: unique().on(table.entitySlug, table.embeddingKind, table.modelVersion),
  }),
);

export type EntityEmbedding = typeof entityEmbeddings.$inferSelect;
export type NewEntityEmbedding = typeof entityEmbeddings.$inferInsert;

/**
 * Signal embeddings — denormalized across multiple source tables.
 * Rather than adding a vector column on every signal-source table,
 * keep embeddings centralized keyed by (signal_id, signal_source).
 * Query patterns join back to the source table by id.
 *
 * signal_id is text (not uuid / bigint) because procur's signal
 * sources use mixed PK types — entity_news_events uses uuid,
 * customs_imports uses bigserial, etc.
 */
export const signalEmbeddings = pgTable(
  'signal_embeddings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    signalId: text('signal_id').notNull(),
    /** 'entity_news_events' | 'customs_imports' | etc. */
    signalSource: text('signal_source').notNull(),
    /** 'text_v1' (content-derived) | 'graph_v1' (graph-context-derived). */
    embeddingKind: text('embedding_kind').notNull(),
    embedding: vector('embedding', { dimensions: 128 }).notNull(),
    modelVersion: text('model_version').notNull(),
    trainedAt: timestamp('trained_at').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => ({
    signalIdx: index('signal_embeddings_signal_idx').on(table.signalId, table.signalSource),
    kindIdx: index('signal_embeddings_kind_idx').on(table.embeddingKind),
    hnswIdx: index('signal_embeddings_hnsw_idx')
      .using('hnsw', table.embedding.op('vector_cosine_ops')),
    uniqByModel: unique().on(
      table.signalId,
      table.signalSource,
      table.embeddingKind,
      table.modelVersion,
    ),
  }),
);

export type SignalEmbedding = typeof signalEmbeddings.$inferSelect;
export type NewSignalEmbedding = typeof signalEmbeddings.$inferInsert;
