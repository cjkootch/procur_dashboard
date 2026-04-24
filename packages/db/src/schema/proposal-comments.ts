import { pgTable, uuid, text, timestamp, index } from 'drizzle-orm/pg-core';
import { proposals } from './proposals';
import { users } from './users';

export const proposalComments = pgTable(
  'proposal_comments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    proposalId: uuid('proposal_id')
      .references(() => proposals.id, { onDelete: 'cascade' })
      .notNull(),
    // null = proposal-level comment, otherwise the section id inside proposals.outline
    sectionId: uuid('section_id'),
    body: text('body').notNull(),
    createdBy: uuid('created_by')
      .references(() => users.id)
      .notNull(),
    resolvedAt: timestamp('resolved_at'),
    resolvedBy: uuid('resolved_by').references(() => users.id),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => ({
    proposalIdx: index('proposal_comments_proposal_idx').on(table.proposalId),
    sectionIdx: index('proposal_comments_section_idx').on(table.proposalId, table.sectionId),
  }),
);

export type ProposalComment = typeof proposalComments.$inferSelect;
export type NewProposalComment = typeof proposalComments.$inferInsert;
