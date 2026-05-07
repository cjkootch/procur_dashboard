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
      .references(() => users.id)
      .notNull(),
    title: text('title').notNull().default('New conversation'),
    /** Optional pin to a fuel_deal (text ULID, no FK declared — same
     *  convention as touchpoints.deal_id). Powers the /deals/[id]
     *  room's Assistant chats tab + propose_attach_to_deal chat tool. */
    dealId: text('deal_id'),
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
    dealIdx: index('assistant_threads_deal_idx').on(table.dealId),
  }),
);

export type AssistantThread = typeof assistantThreads.$inferSelect;
export type NewAssistantThread = typeof assistantThreads.$inferInsert;
