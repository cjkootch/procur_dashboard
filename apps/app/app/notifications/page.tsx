import type { ReactNode } from 'react';
import { AppShell } from '../../components/shell/AppShell';
import { requireCompany } from '@procur/auth';
import { listAllNotifications } from '../../lib/notification-queries';
import {
  markAllNotificationsReadAction,
  markNotificationReadAction,
} from './actions';

export const dynamic = 'force-dynamic';

export default async function NotificationsPage() {
  const { user } = await requireCompany();
  const items = await listAllNotifications(user.id);
  const unread = items.filter((n) => !n.readAt);
  const grouped = groupByDay(items);

  return (
    <AppShell title="Notifications">
      <div className="mx-auto max-w-3xl px-8 py-10">
        <header className="mb-6 flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Notifications</h1>
            <p className="mt-1 text-sm text-[color:var(--color-muted-foreground)]">
              Recent activity on pursuits, gate reviews, and tasks where you&rsquo;re
              the assignee.
            </p>
          </div>
          {unread.length > 0 && (
            <form action={markAllNotificationsReadAction}>
              <button
                type="submit"
                className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] px-3 py-1.5 text-xs hover:bg-[color:var(--color-muted)]/40"
              >
                Mark all read ({unread.length})
              </button>
            </form>
          )}
        </header>

        {items.length === 0 ? (
          <Empty />
        ) : (
          <div className="space-y-6">
            {grouped.map((g) => (
              <Group key={g.label} label={g.label}>
                <ul className="divide-y divide-[color:var(--color-border)] rounded-[var(--radius-md)] border border-[color:var(--color-border)]">
                  {g.items.map((n) => (
                    <li key={n.id}>
                      <form action={markNotificationReadAction}>
                        <input type="hidden" name="notificationId" value={n.id} />
                        <button
                          type="submit"
                          className={`block w-full px-4 py-3 text-left transition hover:bg-[color:var(--color-muted)]/40 ${
                            !n.readAt ? 'bg-blue-50/40' : ''
                          }`}
                        >
                          <div className="flex items-baseline justify-between gap-3">
                            <span
                              className={`text-sm ${!n.readAt ? 'font-semibold' : 'text-[color:var(--color-muted-foreground)]'}`}
                            >
                              {n.title}
                            </span>
                            <span className="shrink-0 text-[11px] text-[color:var(--color-muted-foreground)]">
                              {new Date(n.createdAt).toLocaleString(undefined, {
                                hour: 'numeric',
                                minute: '2-digit',
                              })}
                            </span>
                          </div>
                          {n.body && (
                            <p className="mt-1 text-xs text-[color:var(--color-muted-foreground)]">
                              {n.body}
                            </p>
                          )}
                          <p className="mt-1 text-[10px] uppercase tracking-wider text-[color:var(--color-muted-foreground)]">
                            {n.type.replace(/[._]/g, ' ')}
                          </p>
                        </button>
                      </form>
                    </li>
                  ))}
                </ul>
              </Group>
            ))}
          </div>
        )}
      </div>
    </AppShell>
  );
}

function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section>
      <h2 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-[color:var(--color-muted-foreground)]">
        {label}
      </h2>
      {children}
    </section>
  );
}

function Empty() {
  return (
    <section className="rounded-[var(--radius-md)] border border-dashed border-[color:var(--color-border)] p-10 text-center text-sm text-[color:var(--color-muted-foreground)]">
      Nothing yet. Notifications appear here when teammates move pursuits, sign off
      gate reviews, or assign you tasks.
    </section>
  );
}

const DAY_MS = 24 * 60 * 60 * 1000;

function groupByDay<T extends { createdAt: Date }>(
  items: T[],
): Array<{ label: string; items: T[] }> {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const yesterday = new Date(today.getTime() - DAY_MS);
  const weekStart = new Date(today.getTime() - 7 * DAY_MS);

  const todayItems: T[] = [];
  const yesterdayItems: T[] = [];
  const weekItems: T[] = [];
  const olderItems: T[] = [];

  for (const item of items) {
    const t = new Date(item.createdAt).getTime();
    if (t >= today.getTime()) todayItems.push(item);
    else if (t >= yesterday.getTime()) yesterdayItems.push(item);
    else if (t >= weekStart.getTime()) weekItems.push(item);
    else olderItems.push(item);
  }

  const groups: Array<{ label: string; items: T[] }> = [];
  if (todayItems.length) groups.push({ label: 'Today', items: todayItems });
  if (yesterdayItems.length) groups.push({ label: 'Yesterday', items: yesterdayItems });
  if (weekItems.length) groups.push({ label: 'This week', items: weekItems });
  if (olderItems.length) groups.push({ label: 'Older', items: olderItems });
  return groups;
}
