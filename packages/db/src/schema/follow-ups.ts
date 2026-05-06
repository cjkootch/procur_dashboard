import { check, index, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/**
 * Per docs/vex-into-procur-merge-brief.md Phase 4. Deferred-action
 * primitive — chat commands like "remind me about Acme next Thursday"
 * and "assign this to Jane" both materialise as follow_ups rows. The
 * /follow-ups UI surfaces upcoming + overdue sorted by due_at.
 * `notified_at` is set by the cron notifier so the same row isn't
 * notified twice.
 */
export const followUps = pgTable(
  'follow_ups',
  {
    id: text('id').primaryKey(),
    title: text('title').notNull(),
    note: text('note'),
    dueAt: timestamp('due_at', { withTimezone: true }).notNull(),
    subjectType: text('subject_type'),
    subjectId: text('subject_id'),
    assignedTo: text('assigned_to'),
    createdBy: text('created_by').notNull(),
    status: text('status').notNull().default('open'),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    notifiedAt: timestamp('notified_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    dueIdx: index('follow_ups_due_idx').on(t.status, t.dueAt),
    subjectIdx: index('follow_ups_subject_idx').on(t.subjectType, t.subjectId),
    statusCheck: check(
      'follow_ups_status_check',
      sql`${t.status} IN ('open', 'completed', 'cancelled')`,
    ),
  }),
);

export type FollowUp = typeof followUps.$inferSelect;
export type NewFollowUp = typeof followUps.$inferInsert;
