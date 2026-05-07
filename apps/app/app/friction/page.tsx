import { notFound } from 'next/navigation';
import { getFrictionQueueForUser } from '@procur/catalog';
import { getCurrentUser } from '@procur/auth';
import { FrictionStatusPicker } from './_components/FrictionStatusPicker';

export const dynamic = 'force-dynamic';

/**
 * Friction queue per docs/feedback-ui-brief.md §6.3 — closed-loop
 * surfacing of the user's own friction logs with status. Without
 * this page, friction-logging discipline decays within 30 days
 * (brief discipline note).
 *
 * Status updates inline via FrictionStatusPicker → PATCH route.
 * Markdown-friendly description preserves typed text. Page hint
 * surfaces context (where the user was when they logged the friction).
 */
const STATUS_PILL: Record<string, string> = {
  logged: 'bg-[color:var(--color-muted)]/40 text-[color:var(--color-muted-foreground)]',
  reviewing: 'bg-blue-500/10 text-blue-700',
  in_progress: 'bg-amber-500/10 text-amber-800',
  shipped: 'bg-emerald-500/10 text-emerald-700',
  wontfix: 'bg-red-500/10 text-red-700',
};

export default async function FrictionPage() {
  const user = await getCurrentUser();
  if (!user) notFound();

  const rows = await getFrictionQueueForUser(user.id, 200);

  const counts = rows.reduce<Record<string, number>>((acc, r) => {
    acc[r.status] = (acc[r.status] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <div className="mx-auto max-w-5xl px-4 py-6 md:px-6 md:py-10">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">❓ Friction queue</h1>
        <p className="mt-1 text-sm text-[color:var(--color-muted-foreground)]">
          Things you logged via the floating &ldquo;Stuck?&rdquo; button or{' '}
          <kbd className="rounded border border-[color:var(--color-border)] px-1 text-[10px]">?</kbd>{' '}
          shortcut. Update status as items move through the
          backlog.
        </p>
        <div className="mt-3 flex flex-wrap gap-2 text-xs">
          {(['logged', 'reviewing', 'in_progress', 'shipped', 'wontfix'] as const).map((s) => (
            <span key={s} className={`rounded px-1.5 py-0.5 ${STATUS_PILL[s]}`}>
              {s.replace('_', ' ')}: {counts[s] ?? 0}
            </span>
          ))}
        </div>
      </header>

      {rows.length === 0 ? (
        <p className="text-sm text-[color:var(--color-muted-foreground)]">
          No friction logged yet. Hit <kbd className="rounded border border-[color:var(--color-border)] px-1">?</kbd> on any page when something feels wrong.
        </p>
      ) : (
        <ul className="divide-y divide-[color:var(--color-border)]/60">
          {rows.map((r) => (
            <li key={r.feedbackEventId} className="flex flex-col gap-2 border-b border-[color:var(--color-border)]/40 py-3 last:border-b-0 md:grid md:grid-cols-[140px_minmax(0,1fr)_72px] md:items-start md:gap-3 md:border-b-0">
              <FrictionStatusPicker feedbackEventId={r.feedbackEventId} current={r.status} />
              <div className="min-w-0">
                <p className="whitespace-pre-wrap text-sm">{r.description}</p>
                <div className="mt-1 flex flex-wrap gap-2 text-[11px] text-[color:var(--color-muted-foreground)]">
                  {r.page && <span>on <code className="rounded bg-[color:var(--color-muted)] px-1 font-mono">{r.page}</code></span>}
                  <span>· {formatRelative(r.loggedAt)}</span>
                  {r.relatedPrUrl && (
                    <a
                      href={r.relatedPrUrl}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="underline hover:text-[color:var(--color-foreground)]"
                    >
                      · PR
                    </a>
                  )}
                </div>
              </div>
              <span className="text-right text-[11px] text-[color:var(--color-muted-foreground)]">
                {r.resolvedAt ? `✓ ${formatRelative(r.resolvedAt)}` : ''}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function formatRelative(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return iso;
  const days = Math.floor((Date.now() - t) / 86400000);
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}
