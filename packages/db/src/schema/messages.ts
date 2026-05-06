import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { messageDirectionEnum } from './enums';
import { threads } from './threads';

/**
 * Per docs/vex-into-procur-merge-brief.md Phase 3. Individual message
 * within a thread. `content_ref` is a pointer to blob storage; body
 * text/html live in `metadata` JSONB (capped 64KB by the normalizer).
 * Email-specific columns added in migration 0080: subject, from_email,
 * message_id (RFC-5322), in_reply_to.
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
    /** Email subject. Null for non-email channels. */
    subject: text('subject'),
    /** Sender email (lower-cased on insert). Null for non-email. */
    fromEmail: text('from_email'),
    /** RFC-5322 Message-ID. Unique when populated; powers in_reply_to
     *  threading lookups. Null for non-email channels (sms / whatsapp /
     *  voice use their own provider id semantics). */
    messageId: text('message_id'),
    /** Parent's RFC-5322 Message-ID. Powers thread stitching when the
     *  inbound webhook resolves a reply to its predecessor. */
    inReplyTo: text('in_reply_to'),
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
    messageIdUniq: uniqueIndex('messages_message_id_uniq')
      .on(t.messageId)
      .where(sql`${t.messageId} IS NOT NULL`),
    inReplyToIdx: index('messages_in_reply_to_idx')
      .on(t.inReplyTo)
      .where(sql`${t.inReplyTo} IS NOT NULL`),
    fromEmailIdx: index('messages_from_email_idx')
      .on(t.fromEmail)
      .where(sql`${t.fromEmail} IS NOT NULL`),
  }),
);

export type Message = typeof messages.$inferSelect;
export type NewMessage = typeof messages.$inferInsert;
