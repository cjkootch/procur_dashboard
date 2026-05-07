import 'server-only';
import { and, desc, eq, gt, isNotNull, isNull, sql } from 'drizzle-orm';
import {
  db,
  notifications,
  users,
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

/**
 * Fan-out helper for events that don't carry a specific recipient —
 * inbound email/SMS arrives at the company, not at a user. Writes one
 * notification row per active operator, honoring per-user mute
 * preferences.
 *
 * Single-tenant deployment: this currently means "every user with a
 * companyId set". When per-tenant scoping matters (multi-company
 * deployment), narrow the SELECT to the inferred company.
 */
export async function notifyAllOperators(input: {
  type: string;
  title: string;
  body?: string | null;
  link?: string | null;
  entityType?: string | null;
  entityId?: string | null;
}): Promise<void> {
  try {
    const operators = await db
      .select({ id: users.id, companyId: users.companyId })
      .from(users)
      .where(isNotNull(users.companyId));
    if (operators.length === 0) return;

    const enabled = await filterRecipientsByPreference(
      operators.map((u) => u.id),
      input.type,
    );
    const enabledSet = new Set(enabled);
    const rows: NewNotification[] = operators
      .filter((u) => enabledSet.has(u.id) && u.companyId)
      .map((u) => ({
        userId: u.id,
        companyId: u.companyId as string,
        type: input.type,
        title: input.title,
        body: input.body ?? null,
        link: input.link ?? null,
        entityType: input.entityType ?? null,
        entityId: (input.entityId as string | null) ?? null,
      }));
    if (rows.length === 0) return;
    await db.insert(notifications).values(rows);
  } catch (err) {
    console.error('[notifications] fan-out failed', err);
  }
}

/**
 * Cheap polling endpoint payload — current unread count + latest
 * createdAt. The bell client component compares the latest createdAt
 * to its previous tick to decide whether to flash a toast.
 */
export async function getNotificationPollState(
  userId: string,
): Promise<{ unread: number; latestCreatedAt: string | null }> {
  const [counts] = await db
    .select({
      unread: sql<number>`count(*) FILTER (WHERE ${notifications.readAt} IS NULL)::int`,
      latest: sql<string | null>`MAX(${notifications.createdAt})::text`,
    })
    .from(notifications)
    .where(eq(notifications.userId, userId));
  return {
    unread: counts?.unread ?? 0,
    latestCreatedAt: counts?.latest ?? null,
  };
}

/**
 * Notifications created strictly after the given ISO timestamp — used
 * by the bell's poll loop to surface a toast for "new since last tick"
 * rather than every unread row.
 */
export async function listNotificationsSince(
  userId: string,
  sinceIso: string,
  limit = 5,
): Promise<Notification[]> {
  const since = new Date(sinceIso);
  if (Number.isNaN(since.getTime())) return [];
  return db
    .select()
    .from(notifications)
    .where(
      and(
        eq(notifications.userId, userId),
        gt(notifications.createdAt, since),
      ),
    )
    .orderBy(desc(notifications.createdAt))
    .limit(limit);
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
