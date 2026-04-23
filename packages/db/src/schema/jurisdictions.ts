import { pgTable, uuid, text, timestamp, jsonb, boolean, integer } from 'drizzle-orm/pg-core';
import { regionEnum } from './enums';

export const jurisdictions = pgTable('jurisdictions', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  countryCode: text('country_code').notNull(),
  region: regionEnum('region').notNull(),

  portalName: text('portal_name'),
  portalUrl: text('portal_url'),
  scraperModule: text('scraper_module'),

  currency: text('currency'),
  language: text('language').default('en'),
  timezone: text('timezone'),

  active: boolean('active').default(true).notNull(),
  lastSuccessfulScrapeAt: timestamp('last_successful_scrape_at'),
  consecutiveFailures: integer('consecutive_failures').default(0),
  opportunitiesCount: integer('opportunities_count').default(0),

  metadata: jsonb('metadata'),

  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export type Jurisdiction = typeof jurisdictions.$inferSelect;
export type NewJurisdiction = typeof jurisdictions.$inferInsert;
