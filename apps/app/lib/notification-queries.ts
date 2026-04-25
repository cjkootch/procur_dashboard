import 'server-only';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import {
  db,
  notifications,
  type NewNotification,
  type Notification,
} from '@procur/db';
import {
  filterRecipientsByPreference,
  notificationsEnabledFor,
} from './notification-preferences';

/**
 * Notification producer. Always swallows write errors — a notification
 * insert MUST NEVER fail the user-facing action that triggered it.
 *
 * Producers should call this from inside the action that caused the
 * event, AFTER the primary mutation has succeeded.
 *
 * Honors per-user preferences: if the recipient has muted this type
 * via /settings/notifications, the row is silently skipped.
 */
export async function insertNotification(input: NewNotification): Promise<void> {
  try {
    const enabled = await notificationsEnabledFor(input.userId, input.type);
    if (!enabled) return;
    await db.insert(notifications).values(input);
  } catch (err) {
    console.error('[notifications] insert failed', err, {
      userId: input.userId,
      type: input.type,
    });
  }
}

/**
 * Insert notifications for multiple recipients at once. Filters out
 * users who have muted the type before the bulk insert, so a comment
 * @-mentioning 5 people only writes 3 rows if 2 muted.
 */
export async function insertNotificationsForUsers(
  userIds: string[],
  base: Omit<NewNotification, 'userId'>,
): Promise<void> {
  if (userIds.length === 0) return;
  try {
    const recipients = await filterRecipientsByPreference(userIds, base.type);
    if (recipients.length === 0) return;
    const rows = recipients.map((userId) => ({ ...base, userId }));
    await db.insert(notifications).values(rows);
  } catch (err) {
    console.error('[notifications] bulk insert failed', err);
  }
}

/** Unread count for the bell badge. Hot path — runs on every page render. */
export async function getUnreadNotificationCount(userId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(notifications)
    .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)));
  return row?.n ?? 0;
}

/** Recent notifications for the dropdown (newest first, capped). */
export async function listRecentNotifications(
  userId: string,
  limit = 8,
): Promise<Notification[]> {
  return db
    .select()
    .from(notifications)
    .where(eq(notifications.userId, userId))
    .orderBy(desc(notifications.createdAt))
    .limit(limit);
}

/** Full history for the /notifications inbox page. */
export async function listAllNotifications(userId: string): Promise<Notification[]> {
  return db
    .select()
    .from(notifications)
    .where(eq(notifications.userId, userId))
    .orderBy(desc(notifications.createdAt))
    .limit(200);
}
