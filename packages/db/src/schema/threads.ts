import { index, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * Per docs/vex-into-procur-merge-brief.md Phase 3. Communications
 * thread — one row per conversation across email / sms / call /
 * whatsapp. `participant_ids` is a free-form array of contact ids;
 * `subject` is the email-style subject line. Messages belong to a
 * thread.
 */
export const threads = pgTable(
  'threads',
  {
    id: text('id').primaryKey(),
    channel: text('channel').notNull(),
    subject: text('subject'),
    participantIds: jsonb('participant_ids')
      .$type<string[]>()
      .notNull()
      .default([]),
    lastMessageAt: timestamp('last_message_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    channelIdx: index('threads_channel_idx').on(t.channel),
    lastMessageAtIdx: index('threads_last_message_at_idx').on(t.lastMessageAt),
  }),
);

export type Thread = typeof threads.$inferSelect;
export type NewThread = typeof threads.$inferInsert;
