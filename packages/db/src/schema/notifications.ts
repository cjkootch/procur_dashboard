import { pgTable, uuid, text, timestamp, index } from 'drizzle-orm/pg-core';
import { companies } from './companies';
import { users } from './users';

/**
 * In-app notifications inbox. Lives separately from `audit_log` because:
 *   - audit_log is system-of-record (every event), notifications are
 *     curated user-relevant events;
 *   - notifications carry per-user read state (audit log doesn't);
 *   - notifications need a different query pattern (per-user unread count
 *     on every page render → hot path with a tight composite index).
 *
 * `type` is free-text so producers can add new event categories without
 * migrating the schema; the inbox UI groups by a small set of known
 * types and falls through to a generic icon for unknowns.
 */

export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /** Recipient. Notifications are per-user; multi-recipient events fan
        out to one row per user. */
    userId: uuid('user_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    /** Tenant scope. Lets cross-company moves invalidate cleanly + keeps
        the inbox query a single composite-index lookup. */
    companyId: uuid('company_id')
      .references(() => companies.id, { onDelete: 'cascade' })
      .notNull(),

    /** Event type — free-text. Examples: 'pursuit.gate_review_created',
        'pursuit.task_assigned', 'pursuit.stage_moved'. */
    type: text('type').notNull(),

    title: text('title').notNull(),
    /** Optional secondary text shown in the dropdown row + on the inbox page. */
    body: text('body'),
    /** Where to navigate when the user clicks the row. Relative path. */
    link: text('link'),

    /** Optional reference to the entity that triggered the notification.
        Lets the UI deep-link without parsing the URL, and lets us bulk-
        clear notifications for a deleted entity later. */
    entityType: text('entity_type'),
    entityId: uuid('entity_id'),

    readAt: timestamp('read_at'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => ({
    // Hot path: SELECT … WHERE user_id = ? AND read_at IS NULL ORDER BY created_at DESC.
    userReadIdx: index('notifications_user_read_idx').on(
      table.userId,
      table.readAt,
      table.createdAt,
    ),
  }),
);

export type Notification = typeof notifications.$inferSelect;
export type NewNotification = typeof notifications.$inferInsert;
