'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

/**
 * Client-side polling + toast layer paired with the server-rendered
 * <NotificationsBell>. Polls /api/notifications/poll every 30s (and
 * on tab refocus). When the unread count increases or new rows
 * arrived since the last tick, this:
 *
 *   1. Flashes a toast in the bottom-left for ~6s with the title +
 *      a link to the notification's target. The toast stacks up to 3
 *      so a flurry of inbound emails doesn't pile into infinity.
 *   2. Calls `router.refresh()` so the server-rendered bell badge
 *      re-renders with the new count without a full reload.
 *
 * Skip the service-worker / native browser-push route for now —
 * adds a permission prompt + SW boilerplate that's heavy for a
 * single-operator deployment. Polling is cheap and works while the
 * tab is open.
 *
 * Polling pauses while the tab is hidden (document.visibilityState),
 * resuming on visibility change so we don't burn requests in the
 * background.
 */

const POLL_INTERVAL_MS = 30_000;
const TOAST_DURATION_MS = 6_000;
const TOAST_STACK_LIMIT = 3;

interface ToastItem {
  id: string;
  title: string;
  link: string | null;
}

interface PollResponse {
  unread: number;
  latest: string | null;
  newSince: { id: string; title: string; link: string | null }[];
}

export function NotificationsLiveLayer({
  initialLatest,
}: {
  /** Most recent createdAt at the time the page rendered. */
  initialLatest: string | null;
}) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const lastSeenRef = useRef<string | null>(initialLatest);
  // ID-level dedup. The timestamp comparison alone wasn't enough:
  // Postgres timestamps carry microsecond precision; serializing
  // MAX(created_at)::text on the server, parsing back through
  // `new Date()` on the client, then re-serializing for the next
  // poll's `since` param truncates to milliseconds. So the
  // server-side `WHERE created_at > since` keeps matching the same
  // row, and the toast for an hours-old email kept re-firing on
  // every 30s tick. Tracking IDs we've already shown is precision-
  // independent.
  const seenIdsRef = useRef<Set<string>>(new Set());
  const router = useRouter();

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const tick = useCallback(async () => {
    if (typeof document !== 'undefined' && document.hidden) return;
    try {
      const url = new URL(
        '/api/notifications/poll',
        window.location.origin,
      );
      if (lastSeenRef.current) {
        url.searchParams.set('since', lastSeenRef.current);
      }
      const res = await fetch(url.toString(), { cache: 'no-store' });
      if (!res.ok) return;
      const body = (await res.json()) as PollResponse;
      // Filter out anything we already toasted in this session.
      const fresh = body.newSince.filter((n) => !seenIdsRef.current.has(n.id));
      if (fresh.length > 0) {
        for (const n of fresh) seenIdsRef.current.add(n.id);
        // Stack new toasts on top, capped — avoids infinite pile-up.
        setToasts((prev) =>
          [...fresh.map((n) => ({ id: n.id, title: n.title, link: n.link })), ...prev].slice(
            0,
            TOAST_STACK_LIMIT,
          ),
        );
        // Auto-dismiss each new toast after TOAST_DURATION_MS.
        for (const n of fresh) {
          setTimeout(() => dismissToast(n.id), TOAST_DURATION_MS);
        }
        // Refresh server components so the bell badge updates.
        router.refresh();
      }
      if (body.latest) lastSeenRef.current = body.latest;
    } catch {
      // Network blip — silently ignore. The next tick will retry.
    }
  }, [router, dismissToast]);

  useEffect(() => {
    const id = setInterval(() => void tick(), POLL_INTERVAL_MS);
    const onVisible = () => {
      if (!document.hidden) void tick();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [tick]);

  if (toasts.length === 0) return null;

  return (
    <div
      // Bottom-left so the right-side launcher pills (Stuck? / Ask)
      // stay clear. Stack newest-on-top.
      className="pointer-events-none fixed bottom-4 left-4 z-[1100] flex flex-col-reverse gap-2"
      role="status"
      aria-live="polite"
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          className="pointer-events-auto flex w-[min(95vw,360px)] items-center gap-3 rounded-[var(--radius-md)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-3 py-2 shadow-xl"
        >
          <span
            className="inline-block h-2 w-2 shrink-0 rounded-full bg-emerald-500"
            aria-hidden
          />
          <div className="min-w-0 flex-1 text-sm">
            {t.link ? (
              <Link
                href={t.link}
                onClick={() => dismissToast(t.id)}
                className="block truncate font-medium hover:underline"
              >
                {t.title}
              </Link>
            ) : (
              <span className="block truncate font-medium">{t.title}</span>
            )}
          </div>
          <button
            type="button"
            onClick={() => dismissToast(t.id)}
            aria-label="Dismiss"
            className="text-xs text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-foreground)]"
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
