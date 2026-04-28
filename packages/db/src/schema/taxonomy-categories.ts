import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  boolean,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';

export const taxonomyCategories = pgTable('taxonomy_categories', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  // FK targets `slug` (which is UNIQUE) rather than `id` so existing
  // readers across the codebase keep working without a column rename.
  // ON DELETE SET NULL — child categories survive a parent deletion as
  // top-level entries rather than disappearing.
  parentSlug: text('parent_slug').references(
    (): AnyPgColumn => taxonomyCategories.slug,
    { onDelete: 'set null' },
  ),
  description: text('description'),
  sortOrder: integer('sort_order').default(0),
  active: boolean('active').default(true).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export type TaxonomyCategory = typeof taxonomyCategories.$inferSelect;
export type NewTaxonomyCategory = typeof taxonomyCategories.$inferInsert;
