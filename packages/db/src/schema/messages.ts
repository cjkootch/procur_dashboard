import { index, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { messageDirectionEnum } from './enums';
import { threads } from './threads';

/**
 * Per docs/vex-into-procur-merge-brief.md Phase 3. Individual message
 * within a thread. `content_ref` is a pointer to blob storage (raw
 * email body, transcript, sms body) — this row carries metadata only.
 * `sentiment` + `outcome` are agent-classified post-hoc.
 */
export const messages = pgTable(
  'messages',
  {
    id: text('id').primaryKey(),
    threadId: text('thread_id')
      .notNull()
      .references(() => threads.id, { onDelete: 'cascade' }),
    direction: messageDirectionEnum('direction').notNull(),
    contentRef: text('content_ref'),
    sentiment: text('sentiment'),
    outcome: text('outcome'),
    metadata: jsonb('metadata')
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    threadIdx: index('messages_thread_idx').on(t.threadId),
    createdAtIdx: index('messages_created_at_idx').on(t.createdAt),
  }),
);

export type Message = typeof messages.$inferSelect;
export type NewMessage = typeof messages.$inferInsert;
