import {
  customType,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  vector,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/**
 * `search_vector` is a tsvector column produced by a STORED GENERATED
 * expression in the migration. Drizzle has no built-in tsvector type,
 * so we declare a read-only custom type.
 */
const tsvector = customType<{ data: string; driverData: string }>({
  dataType: () => 'tsvector',
});

/**
 * Per docs/vex-into-procur-merge-brief.md Phase 2. Polymorphic
 * embedding store for retrieval-augmented generation across the agent
 * runtime — owner_object_type + owner_object_id point at the source
 * entity (organization, contact, fuel_deal, summary, …). 1536-dim
 * matches OpenAI text-embedding-3-small. Coexists with procur's
 * existing entity_embeddings (graph, 128-dim) and entity_text_embeddings
 * (text, 1536-dim) — different scopes, different ownership.
 */
export const embeddingChunks = pgTable(
  'embedding_chunks',
  {
    id: text('id').primaryKey(),
    ownerObjectType: text('owner_object_type').notNull(),
    ownerObjectId: text('owner_object_id').notNull(),
    chunkText: text('chunk_text').notNull(),
    searchVector: tsvector('search_vector'),
    embedding: vector('embedding', { dimensions: 1536 }).notNull(),
    permissionScope: text('permission_scope').notNull().default('workspace'),
    metadata: jsonb('metadata')
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    ownerIdx: index('embedding_chunks_owner_idx').on(
      t.ownerObjectType,
      t.ownerObjectId,
    ),
    searchVectorIdx: index('embedding_chunks_search_vector_idx')
      .using('gin', t.searchVector)
      .where(sql`search_vector IS NOT NULL`),
  }),
);

export type EmbeddingChunk = typeof embeddingChunks.$inferSelect;
export type NewEmbeddingChunk = typeof embeddingChunks.$inferInsert;
