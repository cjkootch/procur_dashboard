import Link from 'next/link';
import {
  describeActivity,
  type ActivityFeedEntry,
} from '../../lib/activity-feed';

/**
 * Company-wide activity feed for the home dashboard.
 *
 * Renders one row per meaningful event. `describeActivity` may return
 * null for events we don't want to surface (e.g. gate-review updates
 * that didn't change the decision); those rows are filtered out here
 * rather than at the SQL layer so we keep one curated list and
 * dropping a row doesn't shrink the perceived "recent N" count below
 * the threshold.
 */
export function ActivityFeed({ entries }: { entries: ActivityFeedEntry[] }) {
  const rendered = entries
    .map((e) => ({ entry: e, ...(describeActivity(e) ?? { verb: null, detail: null }) }))
    .filter(
      (r): r is { entry: ActivityFeedEntry; verb: string; detail: string | null } =>
        r.verb != null,
    );

  if (rendered.length === 0) return null;

  return (
    <section className="mb-8">
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
        Recent activity
      </h2>
      <ul className="divide-y divide-[color:var(--color-border)] rounded-[var(--radius-lg)] border border-[color:var(--color-border)]">
        {rendered.map(({ entry, verb, detail }) => {
          const href = entry.pursuitId ? `/capture/pursuits/${entry.pursuitId}` : null;
          const inner = (
            <div className="flex items-baseline justify-between gap-3 px-4 py-2.5 text-sm">
              <div className="min-w-0">
                <p className="truncate">
                  <span className="font-medium">{entry.actorName ?? 'Someone'}</span>{' '}
                  <span className="text-[color:var(--color-muted-foreground)]">
                    {verb}
                  </span>
                  {entry.pursuitTitle && (
                    <>
                      {' '}
                      <span className="text-[color:var(--color-foreground)]">
                        {entry.pursuitTitle}
                      </span>
                    </>
                  )}
                </p>
                {detail && (
                  <p className="text-[11px] text-[color:var(--color-muted-foreground)]">
                    {detail}
                  </p>
                )}
              </div>
              <span className="shrink-0 text-[11px] text-[color:var(--color-muted-foreground)]">
                {relativeTime(entry.createdAt)}
              </span>
            </div>
          );
          return (
            <li key={entry.id}>
              {href ? (
                <Link
                  href={href}
                  className="block transition hover:bg-[color:var(--color-muted)]/40"
                >
                  {inner}
                </Link>
              ) : (
                <div>{inner}</div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function relativeTime(d: Date): string {
  const diff = Date.now() - new Date(d).getTime();
  if (diff < MINUTE) return 'just now';
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)}m ago`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)}h ago`;
  if (diff < 7 * DAY) return `${Math.floor(diff / DAY)}d ago`;
  return new Date(d).toLocaleDateString();
}
