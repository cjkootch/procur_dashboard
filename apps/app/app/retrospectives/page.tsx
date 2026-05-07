import Link from 'next/link';
import { notFound } from 'next/navigation';
import { listRetrospectivesForUser, type RetrospectiveQueueRow } from '@procur/catalog';
import { getCurrentUser } from '@procur/auth';

export const dynamic = 'force-dynamic';

/**
 * Retrospective queue index per docs/feedback-ui-brief.md §8.
 * Lists drafts at the top (work in progress), then completed
 * retrospectives newest first. Drafts persist via Save Draft on
 * the per-deal form page.
 *
 * Reachable via: direct URL, future cron's 7-day notification email,
 * or vex's deal-closure webhook (deferred per brief).
 */
const OUTCOME_PILL: Record<RetrospectiveQueueRow['dealOutcome'], string> = {
  won: 'bg-emerald-500/15 text-emerald-800',
  lost: 'bg-red-500/10 text-red-700',
  dead: 'bg-[color:var(--color-muted)]/60 text-[color:var(--color-muted-foreground)]',
};

const INSIGHT_LABEL: Record<string, string> = {
  yes_materially: 'mattered ✓✓',
  yes_marginally: 'mattered ✓',
  no: "didn't matter",
  na: 'n/a',
};

export default async function RetrospectivesIndexPage() {
  const user = await getCurrentUser();
  if (!user) notFound();

  const rows = await listRetrospectivesForUser(user.id, 200);
  const drafts = rows.filter((r) => r.isDraft);
  const completed = rows.filter((r) => !r.isDraft);

  return (
    <div className="mx-auto max-w-5xl px-4 py-6 md:px-6 md:py-10">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">📓 Deal retrospectives</h1>
        <p className="mt-1 text-sm text-[color:var(--color-muted-foreground)]">
          Structured 5-7 minute retrospectives on closed deals. Lessons
          recorded here surface during similar future deals once ML
          embeddings populate.
        </p>
        <div className="mt-2 flex gap-3 text-xs text-[color:var(--color-muted-foreground)]">
          <span>{drafts.length} draft{drafts.length === 1 ? '' : 's'}</span>
          <span>·</span>
          <span>{completed.length} completed</span>
        </div>
      </header>

      {drafts.length > 0 && (
        <section className="mb-8">
          <h2 className="mb-2 text-sm font-medium uppercase tracking-wide text-amber-700">
            Drafts
          </h2>
          <ul className="divide-y divide-[color:var(--color-border)]/60">
            {drafts.map((r) => (
              <RetrospectiveRow key={r.id} row={r} />
            ))}
          </ul>
        </section>
      )}

      {completed.length === 0 && drafts.length === 0 ? (
        <p className="text-sm text-[color:var(--color-muted-foreground)]">
          No retrospectives yet. Visit{' '}
          <code className="rounded bg-[color:var(--color-muted)] px-1 font-mono text-xs">
            /retrospectives/&lt;dealId&gt;
          </code>{' '}
          to start one.
        </p>
      ) : completed.length > 0 ? (
        <section>
          <h2 className="mb-2 text-sm font-medium uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
            Completed
          </h2>
          <ul className="divide-y divide-[color:var(--color-border)]/60">
            {completed.map((r) => (
              <RetrospectiveRow key={r.id} row={r} />
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

function RetrospectiveRow({ row }: { row: RetrospectiveQueueRow }) {
  return (
    <li className="flex flex-col gap-1.5 border-b border-[color:var(--color-border)]/40 py-3 last:border-b-0 md:grid md:grid-cols-[80px_minmax(0,1fr)_120px_120px] md:items-baseline md:gap-3 md:border-b-0">
      <span className={`inline-flex items-center justify-center rounded px-1.5 py-0.5 text-[11px] font-medium uppercase tracking-wide ${OUTCOME_PILL[row.dealOutcome]}`}>
        {row.dealOutcome}
      </span>
      <div className="min-w-0">
        <Link
          href={`/retrospectives/${encodeURIComponent(row.dealId)}`}
          className="truncate text-sm font-medium hover:underline"
        >
          {row.dealId}
        </Link>
        {row.patternForFuture && (
          <p className="mt-0.5 line-clamp-1 text-xs text-[color:var(--color-muted-foreground)]">
            {row.patternForFuture}
          </p>
        )}
      </div>
      <span className="text-xs text-[color:var(--color-muted-foreground)]">
        {row.procurInsightMattered ? INSIGHT_LABEL[row.procurInsightMattered] ?? row.procurInsightMattered : '—'}
      </span>
      <span className="text-right text-xs text-[color:var(--color-muted-foreground)]">
        {row.completedAt
          ? formatRelative(row.completedAt)
          : `draft · ${formatRelative(row.updatedAt)}`}
      </span>
    </li>
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
