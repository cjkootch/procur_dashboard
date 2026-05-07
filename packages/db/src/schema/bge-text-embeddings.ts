import {
  pgTable,
  uuid,
  text,
  timestamp,
  vector,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

/**
 * BGE-M3 text embeddings — multilingual retrieval space, sits
 * alongside the existing OpenAI text-embedding-3-small embeddings
 * in `entity_text_embeddings`. See migration 0086 for rationale.
 *
 * BGE-M3 is open-source (BAAI, MIT license), 1024-dim dense, covers
 * 100+ languages, and handles documents up to 8192 tokens — so it's
 * the better fit for procur's Spanish / Portuguese / Caribbean
 * counterparties, web-scraped summaries, and inbound emails that
 * the OpenAI model handled marginally well.
 *
 * Two embedding spaces coexist; consumers pick per query. NEVER mix
 * similarity calcs across kinds — cosine distance between an OpenAI
 * vector and a BGE-M3 vector is meaningless.
 *
 * Owner shape: `(owner_type, owner_id)` is polymorphic — accepts
 * entity slugs, message ids, deal note ids, web-summary subject ids.
 * Owner_id is text so both UUIDs and slug strings fit.
 */
export const bgeTextEmbeddings = pgTable(
  'bge_text_embeddings',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    ownerType: text('owner_type').notNull(),
    ownerId: text('owner_id').notNull(),

    /** Composition recipe — 'name' | 'name_plus_aliases' |
        'web_summary_overview' | 'message_body' | 'deal_note_v1' |
        'combined_v1'. Free text; new compositions slot in additively. */
    embeddingKind: text('embedding_kind').notNull(),

    embedding: vector('embedding', { dimensions: 1024 }).notNull(),

    /** Source text that was embedded — audit + re-embed support. */
    sourceText: text('source_text').notNull(),

    /** SHA-256 hex of source_text; producers skip re-embedding when
     *  hash matches an existing row. Nullable for back-compat. */
    contentHash: text('content_hash'),

    /** Detected language (ISO 639-1). Nullable when ambiguous. */
    language: text('language'),

    modelVersion: text('model_version').notNull().default('bge-m3'),

    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    ownerIdx: index('bge_text_embeddings_owner_idx').on(
      table.ownerType,
      table.ownerId,
    ),
    kindIdx: index('bge_text_embeddings_kind_idx').on(table.embeddingKind),
    languageIdx: index('bge_text_embeddings_language_idx').on(table.language),
    hnswIdx: index('bge_text_embeddings_hnsw_idx').using(
      'hnsw',
      table.embedding.op('vector_cosine_ops'),
    ),
    uniqIdx: uniqueIndex('bge_text_embeddings_uniq_idx').on(
      table.ownerType,
      table.ownerId,
      table.embeddingKind,
      table.modelVersion,
    ),
  }),
);

export type BgeTextEmbedding = typeof bgeTextEmbeddings.$inferSelect;
export type NewBgeTextEmbedding = typeof bgeTextEmbeddings.$inferInsert;

/** Owner-type discriminator. Free text in the column; this constant
 *  is just the inventory of values producers/consumers know about,
 *  used for type-narrowed APIs. */
export const BGE_OWNER_TYPES = [
  'entity',
  'message',
  'document',
  'lead',
  'opportunity',
  'deal_note',
  'web_summary',
  'web_fact',
  'loi',
  'icpo',
  'assay',
  'contact',
] as const;
export type BgeOwnerType = (typeof BGE_OWNER_TYPES)[number];
