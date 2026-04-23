import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  integer,
  uniqueIndex,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { jurisdictions } from './jurisdictions';

export const agencies = pgTable(
  'agencies',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    jurisdictionId: uuid('jurisdiction_id')
      .references(() => jurisdictions.id)
      .notNull(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    shortName: text('short_name'),
    type: text('type'),
    parentAgencyId: uuid('parent_agency_id').references((): AnyPgColumn => agencies.id),
    websiteUrl: text('website_url'),
    opportunitiesCount: integer('opportunities_count').default(0),
    metadata: jsonb('metadata'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => ({
    jurSlugIdx: uniqueIndex('agency_jur_slug_idx').on(table.jurisdictionId, table.slug),
  }),
);

export type Agency = typeof agencies.$inferSelect;
export type NewAgency = typeof agencies.$inferInsert;
