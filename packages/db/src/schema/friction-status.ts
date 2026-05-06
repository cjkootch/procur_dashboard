import {
  pgTable,
  uuid,
  text,
  timestamp,
  index,
} from 'drizzle-orm/pg-core';
import { feedbackEvents } from './feedback-events';

/**
 * Pattern 3 (friction logging) lifecycle. Per
 * docs/feedback-ui-brief.md §6.4. Friction events themselves live
 * in feedback_events (kind='friction'); this table tracks the
 * status transitions the analyst (or future Trigger.dev cron)
 * updates.
 *
 * 1:1 with feedback_events.id when a feedback row is created with
 * kind='friction'. Separated so lifecycle stays mutable without
 * mutating the original feedback log.
 */
export const frictionStatus = pgTable(
  'friction_status',
  {
    feedbackEventId: uuid('feedback_event_id')
      .primaryKey()
      .references(() => feedbackEvents.id, { onDelete: 'cascade' }),
    /** 'logged' | 'reviewing' | 'in_progress' | 'shipped' | 'wontfix'. */
    status: text('status').notNull().default('logged'),
    resolutionNote: text('resolution_note'),
    resolvedAt: timestamp('resolved_at'),
    /** PR / issue URL once the friction has a tracking artifact. */
    relatedPrUrl: text('related_pr_url'),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => ({
    statusIdx: index('friction_status_status_idx').on(table.status),
  }),
);

export type FrictionStatus = typeof frictionStatus.$inferSelect;
export type NewFrictionStatus = typeof frictionStatus.$inferInsert;
