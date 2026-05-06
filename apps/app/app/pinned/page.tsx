import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getPinnedMatches } from '@procur/catalog';
import { getCurrentUser } from '@procur/auth';
import { PinActions } from './_components/PinActions';

export const dynamic = 'force-dynamic';

/**
 * Pinned matches per docs/feedback-ui-brief.md §4.3 — "Pin creates a
 * follow-up queue. Pinned matches go to /app/pinned."
 *
 * Reads feedback_events rows where sentiment='pin' for the current
 * user, hydrates against match_queue + known_entities. Server-side
 * filter excludes expired pins (age out after 30 days per brief).
 * Each row gets Extend (+30d) and Unpin (soft-delete) actions.
 */

export default async function PinnedMatchesPage() {
  const user = await getCurrentUser();
  if (!user) notFound();

  const rows = await getPinnedMatches(user.id, 200);

  return (
    <div className="mx-auto max-w-5xl px-6 py-10">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">📌 Pinned matches</h1>
        <p className="mt-1 text-sm text-[color:var(--color-muted-foreground)]">
          Match-queue rows you flagged for follow-up. Pinned during normal
          triage via the <kbd className="rounded border border-[color:var(--color-border)] px-1 text-[10px]">p</kbd> shortcut on{' '}
          <Link href="/suppliers/match-queue" className="underline">
            /suppliers/match-queue
          </Link>
          . Pins age out after 30 days; <code className="rounded bg-[color:var(--color-muted)] px-1 text-[10px]">+30d</code> extends, <code className="rounded bg-[color:var(--color-muted)] px-1 text-[10px]">×</code> unpins.
        </p>
      </header>

      {rows.length === 0 ? (
        <p className="text-sm text-[color:var(--color-muted-foreground)]">
          No pinned matches yet. On the match queue, hit <kbd className="rounded border border-[color:var(--color-border)] px-1">p</kbd> on any row to flag it for follow-up.
        </p>
      ) : (
        <ul className="divide-y divide-[color:var(--color-border)]/60">
          {rows.map((r) => {
            const daysUntilExpiry = Math.max(
              0,
              Math.ceil(
                (new Date(r.expiresAt).getTime() - Date.now()) / 86400000,
              ),
            );
            const expiringSoon = daysUntilExpiry <= 7;
            return (
              <li
                key={r.feedbackEventId}
                className="grid grid-cols-[88px_minmax(0,1fr)_72px_84px_88px] items-center gap-3 py-2.5"
              >
                <span className={pillClass(r.signalType)}>
                  {pillLabel(r.signalType)}
                </span>
                <div className="min-w-0">
                  <div className="flex items-baseline gap-1.5">
                    {r.entityProfileSlug ? (
                      <Link
                        href={`/entities/${r.entityProfileSlug}`}
                        className="truncate text-sm font-medium hover:underline"
                      >
                        {r.sourceEntityName ?? '(unknown)'}
                      </Link>
                    ) : (
                      <span className="truncate text-sm font-medium">
                        {r.sourceEntityName ?? '(deleted)'}
                      </span>
                    )}
                    {r.sourceEntityCountry && (
                      <span className="shrink-0 text-[11px] tabular-nums text-[color:var(--color-muted-foreground)]">
                        {r.sourceEntityCountry}
                      </span>
                    )}
                  </div>
                  {r.rationale && (
                    <p className="mt-0.5 line-clamp-1 text-xs text-[color:var(--color-muted-foreground)]">
                      {r.rationale}
                    </p>
                  )}
                </div>
                <span className="text-right text-xs tabular-nums text-[color:var(--color-muted-foreground)]">
                  {r.score != null ? r.score.toFixed(1) : '—'}
                </span>
                <span
                  className={`text-right text-xs tabular-nums ${expiringSoon ? 'text-amber-700' : 'text-[color:var(--color-muted-foreground)]'}`}
                >
                  expires {daysUntilExpiry}d{expiringSoon ? ' ⚠️' : ''}
                </span>
                <PinActions
                  feedbackEventId={r.feedbackEventId}
                  daysUntilExpiry={daysUntilExpiry}
                />
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function pillClass(signalType: string | null): string {
  const base = 'inline-flex items-center justify-center rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide';
  if (signalType === 'distress_event') return `${base} bg-red-500/10 text-red-700`;
  if (signalType === 'velocity_drop') return `${base} bg-amber-500/10 text-amber-800`;
  if (signalType === 'new_award') return `${base} bg-emerald-500/10 text-emerald-700`;
  return `${base} bg-[color:var(--color-muted)]/40 text-[color:var(--color-muted-foreground)]`;
}

function pillLabel(signalType: string | null): string {
  if (signalType === 'distress_event') return 'distress';
  if (signalType === 'velocity_drop') return 'velocity';
  if (signalType === 'new_award') return 'new award';
  return signalType ?? 'pinned';
}
