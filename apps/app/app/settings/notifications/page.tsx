import { eq } from 'drizzle-orm';
import { db, users } from '@procur/db';
import { requireCompany } from '@procur/auth';
import {
  NOTIFICATION_TYPES,
  type NotificationTypeMeta,
} from '../../../lib/notification-preferences';
import { saveNotificationPreferencesAction } from './actions';

export const dynamic = 'force-dynamic';

export default async function NotificationPreferencesPage() {
  const { user } = await requireCompany();
  const row = await db.query.users.findFirst({
    where: eq(users.id, user.id),
    columns: { preferences: true },
  });
  // Opt-out: missing key → enabled.
  const prefs = row?.preferences?.notifications ?? {};
  const isEnabled = (key: string) => prefs[key] !== false;

  const groups = groupByGroup(NOTIFICATION_TYPES);

  return (
    <div className="mx-auto max-w-3xl px-8 py-10">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Notifications</h1>
        <p className="mt-1 text-sm text-[color:var(--color-muted-foreground)]">
          Choose which events trigger an in-app notification (the bell in the
          top-right). Untoggle anything that&rsquo;s noisy for you.
        </p>
      </header>

      <form action={saveNotificationPreferencesAction} className="space-y-6">
        {groups.map(({ group, items }) => (
          <section
            key={group}
            className="rounded-[var(--radius-md)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] p-4"
          >
            <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-[color:var(--color-muted-foreground)]">
              {GROUP_LABEL[group]}
            </h2>
            <ul className="divide-y divide-[color:var(--color-border)]/60">
              {items.map((t) => (
                <li key={t.key} className="py-3">
                  <label className="flex cursor-pointer items-start justify-between gap-4">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium">{t.label}</p>
                      <p className="text-xs text-[color:var(--color-muted-foreground)]">
                        {t.description}
                      </p>
                    </div>
                    <input
                      type="checkbox"
                      name={t.key}
                      defaultChecked={isEnabled(t.key)}
                      className="mt-1 h-4 w-4 shrink-0 cursor-pointer"
                    />
                  </label>
                </li>
              ))}
            </ul>
          </section>
        ))}

        <div className="flex justify-end">
          <button
            type="submit"
            className="rounded-[var(--radius-md)] bg-[color:var(--color-foreground)] px-4 py-1.5 text-sm font-medium text-[color:var(--color-background)]"
          >
            Save preferences
          </button>
        </div>
      </form>
    </div>
  );
}

const GROUP_LABEL: Record<NotificationTypeMeta['group'], string> = {
  capture: 'Capture',
  proposal: 'Proposal',
};

function groupByGroup(
  items: NotificationTypeMeta[],
): Array<{ group: NotificationTypeMeta['group']; items: NotificationTypeMeta[] }> {
  const map = new Map<NotificationTypeMeta['group'], NotificationTypeMeta[]>();
  for (const t of items) {
    const arr = map.get(t.group) ?? [];
    arr.push(t);
    map.set(t.group, arr);
  }
  return Array.from(map.entries()).map(([group, items]) => ({ group, items }));
}
