import { pgTable, uuid, text, timestamp, index } from 'drizzle-orm/pg-core';
import { companies } from './companies';
import { users } from './users';

export const assistantThreads = pgTable(
  'assistant_threads',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .references(() => companies.id, { onDelete: 'cascade' })
      .notNull(),
    userId: uuid('user_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    title: text('title').notNull().default('New conversation'),
    lastMessageAt: timestamp('last_message_at').defaultNow().notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => ({
    companyUserIdx: index('assistant_threads_company_user_idx').on(
      table.companyId,
      table.userId,
      table.lastMessageAt,
    ),
  }),
);

export type AssistantThread = typeof assistantThreads.$inferSelect;
export type NewAssistantThread = typeof assistantThreads.$inferInsert;
