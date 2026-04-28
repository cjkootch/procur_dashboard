import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  integer,
  index,
  vector,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { companies } from './companies';

export const contentLibrary = pgTable(
  'content_library',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .references(() => companies.id)
      .notNull(),

    type: text('type').notNull(),

    title: text('title').notNull(),
    content: text('content').notNull(),
    structuredContent: jsonb('structured_content'),
    metadata: jsonb('metadata'),
    tags: text('tags').array(),

    embedding: vector('embedding', { dimensions: 1536 }),

    lastUsedAt: timestamp('last_used_at'),
    useCount: integer('use_count').default(0),

    version: integer('version').default(1),
    // Self-FK so version-history pointers can't dangle. ON DELETE SET
    // NULL keeps a row alive when its predecessor is deleted, with the
    // version chain visibly truncated rather than pointing into space.
    previousVersionId: uuid('previous_version_id').references(
      (): AnyPgColumn => contentLibrary.id,
      { onDelete: 'set null' },
    ),

    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => ({
    companyTypeIdx: index('content_lib_company_type_idx').on(table.companyId, table.type),
    embeddingIdx: index('content_lib_embedding_idx').using(
      'hnsw',
      table.embedding.op('vector_cosine_ops'),
    ),
  }),
);

export type ContentLibraryEntry = typeof contentLibrary.$inferSelect;
export type NewContentLibraryEntry = typeof contentLibrary.$inferInsert;
