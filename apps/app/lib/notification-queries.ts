import 'server-only';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import {
  db,
  notifications,
  type NewNotification,
  type Notification,
} from '@procur/db';

/**
 * Notification producer. Always swallows write errors — a notification
 * insert MUST NEVER fail the user-facing action that triggered it.
 *
 * Producers should call this from inside the action that caused the
 * event, AFTER the primary mutation has succeeded.
 */
export async function insertNotification(input: NewNotification): Promise<void> {
  try {
    await db.insert(notifications).values(input);
  } catch (err) {
    console.error('[notifications] insert failed', err, {
      userId: input.userId,
      type: input.type,
    });
  }
}

/**
 * Insert notifications for multiple recipients at once. Used when a
 * pursuit-level event fans out to every member of the company; today
 * we only fan out to a single assignee, but the helper is here for
 * comments / mentions / digests later.
 */
export async function insertNotificationsForUsers(
  userIds: string[],
  base: Omit<NewNotification, 'userId'>,
): Promise<void> {
  if (userIds.length === 0) return;
  const rows = userIds.map((userId) => ({ ...base, userId }));
  try {
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
