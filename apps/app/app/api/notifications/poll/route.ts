import { NextResponse } from 'next/server';
import { getCurrentUser } from '@procur/auth';
import {
  getNotificationPollState,
  listNotificationsSince,
} from '../../../../lib/notification-queries';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/notifications/poll?since=<iso>
 *
 * Cheap state-of-the-bell read. Two roles:
 *
 *   1. The client component polls every ~30s and calls
 *      `router.refresh()` if `unread` ticked up — this re-renders the
 *      server-side <NotificationsBell> with the new count.
 *   2. When `since` is supplied, returns the (capped) titles of
 *      notifications created strictly after that timestamp so the
 *      client can flash an in-app toast for "new since last tick"
 *      rather than every unread row.
 */
export async function GET(req: Request): Promise<Response> {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const url = new URL(req.url);
  const since = url.searchParams.get('since');

  const state = await getNotificationPollState(user.id);

  let newSince: { id: string; title: string; link: string | null }[] = [];
  if (since) {
    const rows = await listNotificationsSince(user.id, since, 5);
    newSince = rows.map((r) => ({
      id: r.id,
      title: r.title,
      link: r.link ?? null,
    }));
  }

  return NextResponse.json({
    unread: state.unread,
    latest: state.latestCreatedAt,
    newSince,
  });
}
