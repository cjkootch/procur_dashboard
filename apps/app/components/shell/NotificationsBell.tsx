import { getCurrentUser } from '@procur/auth';
import {
  getUnreadNotificationCount,
  listRecentNotifications,
} from '../../lib/notification-queries';
import {
  markAllNotificationsReadAction,
  markNotificationReadAction,
} from '../../app/notifications/actions';

/**
 * Notifications bell rendered in the AppShell header.
 *
 * Server component. Uses native <details>/<summary> for click-to-open
 * so we don't need to ship JS — the dropdown lives entirely in the
 * server-rendered HTML and closes on outside click via the browser's
 * default <details> behavior (well, falls open until clicked again,
 * which is acceptable for an inbox surface).
 *
 * The bell never renders for signed-out users because AppShell already
 * redirects them. We still defensively no-op if the user lookup fails.
 */
export async function NotificationsBell() {
  const user = await getCurrentUser();
  if (!user) return null;

  const [unread, recent] = await Promise.all([
    getUnreadNotificationCount(user.id),
    listRecentNotifications(user.id, 8),
  ]);

  return (
    <details className="relative">
      <summary
        className="flex cursor-pointer list-none items-center"
        aria-label={`Notifications${unread > 0 ? ` (${unread} unread)` : ''}`}
      >
        <span
          className="relative inline-flex h-7 w-7 items-center justify-center rounded-[var(--radius-sm)] text-[color:var(--color-foreground)] hover:bg-[color:var(--color-muted)]/40"
        >
          <BellIcon />
          {unread > 0 && (
            <span
              className="absolute -right-0.5 -top-0.5 inline-flex h-3.5 min-w-[0.875rem] items-center justify-center rounded-full bg-red-500 px-1 text-[9px] font-semibold text-white"
              aria-hidden
            >
              {unread > 9 ? '9+' : unread}
            </span>
          )}
        </span>
      </summary>

      <div className="absolute right-0 z-30 mt-2 w-80 rounded-[var(--radius-md)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] shadow-lg">
        <header className="flex items-center justify-between border-b border-[color:var(--color-border)] px-3 py-2">
          <p className="text-xs font-semibold">Notifications</p>
          {unread > 0 && (
            <form action={markAllNotificationsReadAction}>
              <button
                type="submit"
                className="text-[10px] text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-foreground)]"
              >
                Mark all read
              </button>
            </form>
          )}
        </header>

        {recent.length === 0 ? (
          <p className="p-6 text-center text-xs text-[color:var(--color-muted-foreground)]">
            You&rsquo;re all caught up.
          </p>
        ) : (
          <ul className="max-h-96 overflow-y-auto divide-y divide-[color:var(--color-border)]/60">
            {recent.map((n) => (
              <li key={n.id}>
                <form action={markNotificationReadAction}>
                  <input type="hidden" name="notificationId" value={n.id} />
                  <button
                    type="submit"
                    className={`block w-full px-3 py-2 text-left text-xs transition hover:bg-[color:var(--color-muted)]/40 ${
                      !n.readAt ? 'bg-blue-50/40' : ''
                    }`}
                  >
                    <div className="flex items-baseline justify-between gap-2">
                      <span className={`truncate font-medium ${!n.readAt ? '' : 'text-[color:var(--color-muted-foreground)]'}`}>
                        {n.title}
                      </span>
                      <span className="shrink-0 text-[10px] text-[color:var(--color-muted-foreground)]">
                        {relativeTime(n.createdAt)}
                      </span>
                    </div>
                    {n.body && (
                      <p className="mt-0.5 line-clamp-2 text-[11px] text-[color:var(--color-muted-foreground)]">
                        {n.body}
                      </p>
                    )}
                  </button>
                </form>
              </li>
            ))}
          </ul>
        )}

        <footer className="border-t border-[color:var(--color-border)] px-3 py-2 text-center">
          <a
            href="/notifications"
            className="text-[11px] text-[color:var(--color-foreground)] hover:underline"
          >
            View all notifications
          </a>
        </footer>
      </div>
    </details>
  );
}

function BellIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className="h-4 w-4"
    >
      <path d="M10 3a4 4 0 0 0-4 4v3.5L4.5 13h11L14 10.5V7a4 4 0 0 0-4-4Z" />
      <path d="M8.5 16a1.5 1.5 0 0 0 3 0" />
    </svg>
  );
}

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function relativeTime(d: Date): string {
  const diff = Date.now() - new Date(d).getTime();
  if (diff < MINUTE) return 'just now';
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)}m`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)}h`;
  if (diff < 7 * DAY) return `${Math.floor(diff / DAY)}d`;
  return new Date(d).toLocaleDateString();
}
