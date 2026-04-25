import 'server-only';
import { eq } from 'drizzle-orm';
import { db, users } from '@procur/db';

/**
 * Per-user notification preferences. Stored on `users.preferences.notifications`
 * as a flat `{ [type]: boolean }` map. Opt-out model: a missing key
 * means the type is enabled (we want new event types to default to
 * delivered, not silent).
 *
 * The set of types is hardcoded here so adding a new producer also
 * adds it to the settings UI; an enum-driven approach would be more
 * dynamic but loses the human-readable label + group structure.
 */

export type NotificationTypeKey =
  | 'pursuit.stage_moved'
  | 'pursuit.gate_review_decided'
  | 'proposal.comment_mentioned';

export type NotificationTypeMeta = {
  key: NotificationTypeKey;
  label: string;
  description: string;
  group: 'capture' | 'proposal';
};

export const NOTIFICATION_TYPES: NotificationTypeMeta[] = [
  {
    key: 'pursuit.stage_moved',
    label: 'Pursuit stage changes',
    description:
      'When a teammate moves a pursuit you own to a new stage (qualification → capture planning, etc.).',
    group: 'capture',
  },
  {
    key: 'pursuit.gate_review_decided',
    label: 'Gate review decisions',
    description:
      'When a teammate signs off (or fails) a gate review on a pursuit you own.',
    group: 'capture',
  },
  {
    key: 'proposal.comment_mentioned',
    label: 'Comment mentions',
    description: 'When a teammate @-mentions you in a proposal comment.',
    group: 'proposal',
  },
];

/**
 * Check whether a user wants notifications of the given type. Opt-out:
 * unset → true. Used at insertNotification() time to skip the write
 * entirely when the user has muted that type.
 */
export async function notificationsEnabledFor(
  userId: string,
  type: string,
): Promise<boolean> {
  const row = await db.query.users.findFirst({
    where: eq(users.id, userId),
    columns: { preferences: true },
  });
  const map = row?.preferences?.notifications;
  if (!map || typeof map !== 'object') return true;
  // If the key is explicitly false, mute. Anything else → enabled.
  return map[type] !== false;
}

/**
 * Bulk variant for fan-out paths (e.g. comment mentions for N
 * recipients). One query for many users; returns the subset that
 * still want this type.
 */
export async function filterRecipientsByPreference(
  recipientIds: string[],
  type: string,
): Promise<string[]> {
  if (recipientIds.length === 0) return [];
  const rows = await db
    .select({ id: users.id, preferences: users.preferences })
    .from(users);
  // We could narrow the SELECT with inArray, but the tenant size is
  // small (10s-100s of users); the simpler full scan + JS filter is
  // fine and avoids an inArray import.
  const wanted = new Set(recipientIds);
  return rows
    .filter((r) => {
      if (!wanted.has(r.id)) return false;
      const map = r.preferences?.notifications;
      if (!map || typeof map !== 'object') return true;
      return map[type] !== false;
    })
    .map((r) => r.id);
}
