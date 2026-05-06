import Link from 'next/link';
import { requireCompany } from '@procur/auth';
import { getLatestDailyBrief } from '@procur/catalog';
import { refreshDailyBriefAction } from './actions';

export const dynamic = 'force-dynamic';

const SEVERITY_TONE: Record<string, string> = {
  critical: 'bg-red-100 text-red-900',
  warn: 'bg-yellow-100 text-yellow-900',
  info: 'bg-[color:var(--color-muted)]/60',
};

/**
 * Daily brief surface per docs/vex-into-procur-merge-brief.md Phase 6.
 * Reads the latest `daily_brief` summary written by DailyBriefAgent.
 * "Refresh" button re-runs the agent inline.
 */
export default async function BriefPage() {
  await requireCompany();
  const brief = await getLatestDailyBrief();

  return (
    <div className="mx-auto max-w-3xl px-8 py-10">
      <header className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            Daily brief
          </h1>
          {brief?.updatedAt && (
            <p className="mt-1 text-xs text-[color:var(--color-muted-foreground)]">
              Last refreshed{' '}
              <time dateTime={brief.updatedAt.toISOString()}>
                {brief.updatedAt.toLocaleString()}
              </time>
            </p>
          )}
        </div>
        <form action={refreshDailyBriefAction}>
          <button
            type="submit"
            className="rounded-[var(--radius-md)] border border-[color:var(--color-border)] px-3 py-1.5 text-xs font-medium hover:border-[color:var(--color-foreground)]"
          >
            Refresh
          </button>
        </form>
      </header>

      {!brief ? (
        <div className="rounded-[var(--radius-lg)] border border-dashed border-[color:var(--color-border)] p-10 text-center text-sm text-[color:var(--color-muted-foreground)]">
          No daily brief generated yet. Click Refresh to assemble one from
          today&apos;s data.
        </div>
      ) : (
        <>
          <section className="mb-6 rounded-[var(--radius-lg)] border border-[color:var(--color-border)] bg-[color:var(--color-muted)]/20 p-5">
            <p className="text-base">{brief.greeting}</p>
            <p className="mt-2 text-sm font-medium">
              {brief.recommendedFocus}
            </p>
          </section>

          <section className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Pending approvals" value={brief.pendingApprovalsCount} href="/approvals" />
            <Stat label="Unack signals" value={brief.unacknowledgedSignalsCount} href="/signals" />
            <Stat label="Stale leads" value={brief.staleLeadsCount} href="/leads" />
            <Stat label="Active deals" value={brief.activeDealsCount} href="/deals" />
          </section>

          {brief.topApprovals.length > 0 && (
            <Section title="Top pending approvals" href="/approvals">
              <ul className="space-y-2">
                {brief.topApprovals.map((a) => (
                  <li key={a.id} className="text-sm">
                    <Link
                      href={`/approvals/${a.id}`}
                      className="font-mono hover:underline"
                    >
                      {a.actionType}
                    </Link>
                    {a.rationale && (
                      <p className="mt-0.5 text-xs text-[color:var(--color-muted-foreground)]">
                        {a.rationale.slice(0, 200)}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            </Section>
          )}

          {brief.topSignals.length > 0 && (
            <Section title="Top unacknowledged signals" href="/signals">
              <ul className="space-y-2">
                {brief.topSignals.map((s) => (
                  <li key={s.id} className="text-sm">
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-medium ${SEVERITY_TONE[s.severity] ?? ''}`}
                    >
                      {s.severity}
                    </span>{' '}
                    {s.title}
                  </li>
                ))}
              </ul>
            </Section>
          )}

          {brief.riskyDeals.length > 0 && (
            <Section title="Risky deals" href="/deals">
              <ul className="space-y-2">
                {brief.riskyDeals.map((d) => (
                  <li key={d.id} className="text-sm">
                    <Link
                      href={`/deals/${d.id}`}
                      className="font-mono hover:underline"
                    >
                      {d.dealRef}
                    </Link>{' '}
                    <span className="rounded-full bg-[color:var(--color-muted)]/60 px-2 py-0.5 text-xs">
                      {d.status.replace(/_/g, ' ')}
                    </span>
                    {d.complianceHold && (
                      <span className="ml-1 rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-900">
                        compliance hold
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </Section>
          )}

          <section className="mt-6 text-xs text-[color:var(--color-muted-foreground)]">
            Yesterday: {brief.yesterdayCompletedAgentRuns} agent runs
            completed of {brief.yesterdayAgentRuns} total.
          </section>
        </>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  href,
}: {
  label: string;
  value: number;
  href: string;
}) {
  return (
    <Link
      href={href}
      className="rounded-[var(--radius-lg)] border border-[color:var(--color-border)] p-3 transition hover:border-[color:var(--color-foreground)]"
    >
      <p className="text-xs text-[color:var(--color-muted-foreground)]">
        {label}
      </p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
    </Link>
  );
}

function Section({
  title,
  href,
  children,
}: {
  title: string;
  href: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-6 rounded-[var(--radius-lg)] border border-[color:var(--color-border)] p-4">
      <header className="mb-2 flex items-baseline justify-between">
        <h2 className="text-xs font-medium uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
          {title}
        </h2>
        <Link
          href={href}
          className="text-xs text-[color:var(--color-muted-foreground)] hover:underline"
        >
          See all →
        </Link>
      </header>
      {children}
    </section>
  );
}
