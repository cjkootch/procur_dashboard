'use server';

import { eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { db, users } from '@procur/db';
import { requireCompany } from '@procur/auth';
import { NOTIFICATION_TYPES } from '../../../lib/notification-preferences';

/**
 * Save the user's notification preferences. Form posts a checkbox per
 * type; presence = enabled, absence = muted (matching standard HTML
 * checkbox semantics). We rebuild the full map server-side so a
 * removed type also persists as `false`, not as a missing key
 * (otherwise the opt-out default would silently re-enable it).
 */
export async function saveNotificationPreferencesAction(
  formData: FormData,
): Promise<void> {
  const { user } = await requireCompany();

  // Read current preferences so we don't clobber other fields (timezone,
  // language, etc.) on the same JSONB column.
  const row = await db.query.users.findFirst({
    where: eq(users.id, user.id),
    columns: { preferences: true },
  });
  const prior = row?.preferences ?? {};

  const nextNotifications: Record<string, boolean> = {};
  for (const t of NOTIFICATION_TYPES) {
    // Checkbox values are 'on' when checked, missing when unchecked.
    nextNotifications[t.key] = formData.get(t.key) === 'on';
  }

  await db
    .update(users)
    .set({
      preferences: { ...prior, notifications: nextNotifications },
      updatedAt: new Date(),
    })
    .where(eq(users.id, user.id));

  revalidatePath('/settings/notifications');
}
