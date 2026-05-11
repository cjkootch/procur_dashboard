import Link from 'next/link';
import { requireCompany } from '@procur/auth';
import { countArchivedProbes, listProbes } from '@procur/catalog';

export const dynamic = 'force-dynamic';

interface PageProps {
  searchParams: Promise<{ archived?: string }>;
}

const STATUS_TONE: Record<string, string> = {
  planning: 'bg-[color:var(--color-muted)]/60',
  active: 'bg-green-100 text-green-900',
  paused: 'bg-yellow-100 text-yellow-900',
  completed: 'bg-blue-100 text-blue-900',
  abandoned: 'bg-red-100 text-red-900',
};

const TIER_LABEL: Record<number, string> = {
  0: 'Tier 0 · research-only',
  1: 'Tier 1 · first-touch autopilot',
  2: 'Tier 2 · follow-up autopilot',
  3: 'Tier 3 · commercial drafting',
};

/**
 * Market Probes index. Each probe is a bounded autonomous market-
 * prospecting experiment — see migration 0095 for the design rationale.
 *
 * Lists probes newest-first with target/sent/reply counts. The "New
 * probe" button routes to the create form.
 */
export default async function MarketProbesPage({ searchParams }: PageProps) {
  await requireCompany();
  const params = await searchParams;
  const showingArchived = params.archived === '1';
  const [probes, archivedCount] = await Promise.all([
    listProbes({ limit: 50, includeArchived: showingArchived }),
    countArchivedProbes(),
  ]);

  return (
    <div className="mx-auto max-w-5xl px-8 py-10">
      <header className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Market Probes</h1>
          <p className="mt-1 max-w-2xl text-sm text-[color:var(--color-muted-foreground)]">
            Bounded autonomous market-prospecting experiments. Pick a
            small market, hand the agent a scope, let it identify
            candidates and route low-risk first-touch outreach within
            strict caps. The point is to discover whether a market has
            signal, not to close deals.
          </p>
          {archivedCount > 0 && (
            <Link
              href={showingArchived ? '/market-probes' : '/market-probes?archived=1'}
              className="mt-2 inline-block text-xs text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-foreground)] hover:underline"
            >
              {showingArchived
                ? '← Hide archived'
                : `Show archived (${archivedCount}) →`}
            </Link>
          )}
        </div>
        <Link
          href="/market-probes/new"
          className="rounded-[var(--radius-md)] bg-[color:var(--color-foreground)] px-4 py-2 text-sm font-medium text-[color:var(--color-background)]"
        >
          New probe
        </Link>
      </header>

      {probes.length === 0 ? (
        <div className="rounded-[var(--radius-lg)] border border-dashed border-[color:var(--color-border)] p-10 text-center">
          <p className="text-sm text-[color:var(--color-muted-foreground)]">
            No probes yet. The first probe lands the foundation; you
            can experiment with a small market (e.g. Barbados food
            distributors) and see whether the agent&apos;s plan + targets
            match your read.
          </p>
          <Link
            href="/market-probes/new"
            className="mt-4 inline-block text-sm underline"
          >
            Start your first probe →
          </Link>
        </div>
      ) : (
        <div className="space-y-2">
          {probes.map((p) => (
            <Link
              key={p.id}
              href={`/market-probes/${p.id}`}
              className="flex items-start gap-4 rounded-[var(--radius-lg)] border border-[color:var(--color-border)] p-4 transition hover:border-[color:var(--color-foreground)]"
            >
              <div className="flex-1 min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-sm font-medium">{p.marketName}</h2>
                  {p.country && (
                    <span className="rounded-full bg-[color:var(--color-muted)]/60 px-2 py-0.5 text-xs font-mono">
                      {p.country.toUpperCase()}
                    </span>
                  )}
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_TONE[p.status] ?? ''}`}
                  >
                    {p.status}
                  </span>
                  <span className="rounded-full border border-[color:var(--color-border)] px-2 py-0.5 text-xs">
                    {TIER_LABEL[p.tier] ?? `Tier ${p.tier}`}
                  </span>
                </div>
                <p className="mt-1 text-xs text-[color:var(--color-muted-foreground)] line-clamp-2">
                  {p.productThesis}
                </p>
                <p className="mt-1 text-xs text-[color:var(--color-muted-foreground)]">
                  {p.targetCount} target{p.targetCount === 1 ? '' : 's'} ·
                  {' '}{p.sentCount} sent · {p.replyCount} repl
                  {p.replyCount === 1 ? 'y' : 'ies'} ·
                  {' '}cap {p.dailySendLimit}/day, {p.totalSendLimit} total
                </p>
              </div>
              <time
                className="shrink-0 text-xs text-[color:var(--color-muted-foreground)]"
                dateTime={p.createdAt.toISOString()}
              >
                {p.createdAt.toLocaleDateString()}
              </time>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
