import { pgTable, uuid, text, timestamp, numeric, boolean } from 'drizzle-orm/pg-core';
import { alertFrequencyEnum } from './enums';
import { users } from './users';
import { companies } from './companies';

export const alertProfiles = pgTable('alert_profiles', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .references(() => users.id, { onDelete: 'cascade' })
    .notNull(),
  companyId: uuid('company_id').references(() => companies.id),

  name: text('name').notNull(),

  jurisdictions: text('jurisdictions').array(),
  categories: text('categories').array(),
  keywords: text('keywords').array(),
  excludeKeywords: text('exclude_keywords').array(),
  minValue: numeric('min_value'),
  maxValue: numeric('max_value'),

  frequency: alertFrequencyEnum('frequency').default('daily').notNull(),
  emailEnabled: boolean('email_enabled').default(true).notNull(),

  active: boolean('active').default(true).notNull(),
  lastSentAt: timestamp('last_sent_at'),

  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export type AlertProfile = typeof alertProfiles.$inferSelect;
export type NewAlertProfile = typeof alertProfiles.$inferInsert;
