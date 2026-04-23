import { pgTable, uuid, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { users } from './users';
import { opportunities } from './opportunities';

export const savedOpportunities = pgTable(
  'saved_opportunities',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .references(() => users.id)
      .notNull(),
    opportunityId: uuid('opportunity_id')
      .references(() => opportunities.id)
      .notNull(),
    notes: text('notes'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => ({
    userOppIdx: uniqueIndex('saved_user_opp_idx').on(table.userId, table.opportunityId),
  }),
);

export type SavedOpportunity = typeof savedOpportunities.$inferSelect;
export type NewSavedOpportunity = typeof savedOpportunities.$inferInsert;
