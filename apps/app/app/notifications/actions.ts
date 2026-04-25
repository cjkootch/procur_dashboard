'use server';

import { and, eq, isNull } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { db, notifications } from '@procur/db';
import { requireCompany } from '@procur/auth';

/**
 * Mark a single notification read. Scoped by user so one user can't
 * mark another user's notifications even within the same company.
 *
 * If the notification has a link, redirect to it after marking — that's
 * the typical "click the row in the dropdown" flow.
 */
export async function markNotificationReadAction(formData: FormData): Promise<void> {
  const { user } = await requireCompany();
  const notificationId = String(formData.get('notificationId') ?? '');
  if (!notificationId) throw new Error('notificationId required');

  const existing = await db.query.notifications.findFirst({
    where: and(eq(notifications.id, notificationId), eq(notifications.userId, user.id)),
    columns: { id: true, link: true, readAt: true },
  });
  if (!existing) return;

  if (!existing.readAt) {
    await db
      .update(notifications)
      .set({ readAt: new Date() })
      .where(eq(notifications.id, notificationId));
  }

  revalidatePath('/notifications');
  // Re-render the AppShell so the bell badge count drops.
  revalidatePath('/', 'layout');

  if (existing.link) redirect(existing.link);
}

/** Mark every unread notification for the current user as read. */
export async function markAllNotificationsReadAction(): Promise<void> {
  const { user } = await requireCompany();

  await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(and(eq(notifications.userId, user.id), isNull(notifications.readAt)));

  revalidatePath('/notifications');
  revalidatePath('/', 'layout');
}
