import { pgTable, uuid, text, timestamp, integer, boolean } from 'drizzle-orm/pg-core';

export const taxonomyCategories = pgTable('taxonomy_categories', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  parentSlug: text('parent_slug'),
  description: text('description'),
  sortOrder: integer('sort_order').default(0),
  active: boolean('active').default(true).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export type TaxonomyCategory = typeof taxonomyCategories.$inferSelect;
export type NewTaxonomyCategory = typeof taxonomyCategories.$inferInsert;
