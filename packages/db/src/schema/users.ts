import { pgTable, uuid, text, timestamp, jsonb } from 'drizzle-orm/pg-core';
import { userRoleEnum } from './enums';
import { companies } from './companies';

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  clerkId: text('clerk_id').notNull().unique(),
  email: text('email').notNull(),
  firstName: text('first_name'),
  lastName: text('last_name'),
  imageUrl: text('image_url'),
  companyId: uuid('company_id').references(() => companies.id),
  role: userRoleEnum('role').default('member').notNull(),
  preferences: jsonb('preferences').$type<{
    timezone?: string;
    language?: string;
    emailDigestFrequency?: string;
    notifications?: Record<string, boolean>;
  }>(),
  lastActiveAt: timestamp('last_active_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
