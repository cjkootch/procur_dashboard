import { getCurrentCompany, getCurrentUser } from '@procur/auth';
import { UserButton } from '@clerk/nextjs';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getHomeData } from '../lib/home-queries';
import { flagFor, formatDate, timeUntil } from '../lib/format';

export const dynamic = 'force-dynamic';

const STAGE_LABEL: Record<string, string> = {
  identification: 'Identification',
  qualification: 'Qualification',
  capture_planning: 'Capture planning',
  proposal_development: 'Proposal drafting',
  submitted: 'Submitted',
  awarded: 'Awarded',
  lost: 'Lost',
};

export default async function DashboardPage() {
  const user = await getCurrentUser();
  if (!user) redirect('/sign-in');

  const company = await getCurrentCompany();
  const displayName =
    [user.firstName, user.lastName].filter(Boolean).join(' ') || user.email || 'there';

  if (!company) {
    return (
      <main className="mx-auto max-w-3xl px-6 py-12">
        <h1 className="text-3xl font-semibold tracking-tight">Welcome, {displayName}</h1>
        <p className="mt-4 text-sm text-[color:var(--color-muted-foreground)]">
          <Link className="underline" href="/onboarding">
            Complete onboarding to create your organization
          </Link>
        </p>
      </main>
    );
  }

  const data = await getHomeData(company.id);

  return (
    <main className="mx-auto max-w-6xl px-6 py-10">
      <header className="mb-8 flex items-start justify-between gap-4">
        <div>
          <p className="text-sm text-[color:var(--color-muted-foreground)]">Welcome back,</p>
          <h1 className="text-3xl font-semibold tracking-tight">{displayName}</h1>
          <p className="mt-2 text-sm text-[color:var(--color-muted-foreground)]">
            {company.name} · Plan:{' '}
            <span className="font-medium capitalize">{company.planTier}</span>
          </p>
        </div>
        <UserButton afterSignOutUrl="/sign-in" />
      </header>

      <section className="mb-8 grid gap-4 rounded-[var(--radius-lg)] border border-[color:var(--color-border)] p-6 md:grid-cols-4">
        <Fact label="Open pursuits" value={data.openPursuits} linkHref="/capture/pipeline" />
        <Fact label="Submitted" value={data.submittedProposals} linkHref="/proposal" />
        <Fact label="Active contracts" value={data.activeContracts} linkHref="/contract" />
        <Fact label="Total pursuits" value={data.totalPursuits} linkHref="/capture/pursuits" />
      </section>

      <div className="grid gap-6 md:grid-cols-2">
        <section>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
              Upcoming deadlines
            </h2>
            <Link href="/capture/pipeline" className="text-xs underline text-[color:var(--color-muted-foreground)]">
              Pipeline →
            </Link>
          </div>
          {data.upcomingDeadlines.length === 0 ? (
            <div className="rounded-[var(--radius-lg)] border border-dashed border-[color:var(--color-border)] p-6 text-center text-xs text-[color:var(--color-muted-foreground)]">
              No pursuits closing in the next 30 days.
            </div>
          ) : (
            <div className="space-y-2">
              {data.upcomingDeadlines.map((d) => {
                const countdown = timeUntil(d.deadlineAt);
                return (
                  <Link
                    key={d.pursuitId}
                    href={`/capture/pursuits/${d.pursuitId}`}
                    className="flex items-center gap-3 rounded-[var(--radius-lg)] border border-[color:var(--color-border)] p-3 text-sm transition hover:border-[color:var(--color-foreground)]"
                  >
                    <span className="text-lg">{flagFor(d.jurisdictionCountry)}</span>
                    <div className="flex-1">
                      <p className="line-clamp-1 font-medium">{d.opportunityTitle}</p>
                      <p className="mt-0.5 text-xs text-[color:var(--color-muted-foreground)]">
                        {d.agencyName ?? d.jurisdictionName} · {STAGE_LABEL[d.stage] ?? d.stage}
                      </p>
                    </div>
                    <div className="text-right text-xs">
                      <p className="font-medium">{formatDate(d.deadlineAt)}</p>
                      {countdown && countdown !== 'closed' && (
                        <p className="text-[color:var(--color-muted-foreground)]">
                          in {countdown}
                        </p>
                      )}
                    </div>
                  </Link>
                );
              })}
            </div>
          )}
        </section>

        <section>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
              Proposals in progress
            </h2>
            <Link href="/proposal" className="text-xs underline text-[color:var(--color-muted-foreground)]">
              All proposals →
            </Link>
          </div>
          {data.draftingProposals.length === 0 ? (
            <div className="rounded-[var(--radius-lg)] border border-dashed border-[color:var(--color-border)] p-6 text-center text-xs text-[color:var(--color-muted-foreground)]">
              No proposals in drafting.
            </div>
          ) : (
            <div className="space-y-2">
              {data.draftingProposals.map((p) => {
                const compliancePct =
                  p.totalRequirements > 0
                    ? Math.round(
                        ((p.totalRequirements - p.unaddressedRequirements) /
                          p.totalRequirements) *
                          100,
                      )
                    : null;
                return (
                  <Link
                    key={p.pursuitId}
                    href={`/proposal/${p.pursuitId}`}
                    className="block rounded-[var(--radius-lg)] border border-[color:var(--color-border)] p-3 text-sm transition hover:border-[color:var(--color-foreground)]"
                  >
                    <p className="line-clamp-1 font-medium">{p.opportunityTitle}</p>
                    <p className="mt-0.5 text-xs text-[color:var(--color-muted-foreground)]">
                      {p.status.replace('_', ' ')}
                      {compliancePct != null && <> · {compliancePct}% addressed</>}
                      {p.unaddressedRequirements > 0 && (
                        <>
                          {' '}
                          · <span className="text-red-700">{p.unaddressedRequirements} gap{p.unaddressedRequirements === 1 ? '' : 's'}</span>
                        </>
                      )}
                      {p.deadlineAt && <> · closes {formatDate(p.deadlineAt)}</>}
                    </p>
                  </Link>
                );
              })}
            </div>
          )}
        </section>
      </div>

      <section className="mt-8">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
            Upcoming obligations
          </h2>
          <Link href="/contract" className="text-xs underline text-[color:var(--color-muted-foreground)]">
            All contracts →
          </Link>
        </div>
        {data.upcomingObligations.length === 0 ? (
          <div className="rounded-[var(--radius-lg)] border border-dashed border-[color:var(--color-border)] p-6 text-center text-xs text-[color:var(--color-muted-foreground)]">
            No obligations due in the next 30 days.
          </div>
        ) : (
          <div className="space-y-2">
            {data.upcomingObligations.map((o, i) => (
              <Link
                key={`${o.contractId}-${i}`}
                href={`/contract/${o.contractId}`}
                className="flex items-center gap-3 rounded-[var(--radius-lg)] border border-[color:var(--color-border)] p-3 text-sm transition hover:border-[color:var(--color-foreground)]"
              >
                <div className="flex-1">
                  <p className="line-clamp-1 font-medium">{o.description}</p>
                  <p className="mt-0.5 text-xs text-[color:var(--color-muted-foreground)]">
                    {o.contractTitle} · due {formatDate(new Date(o.dueDate))}
                  </p>
                </div>
                <span className="rounded-full bg-[color:var(--color-muted)]/60 px-2 py-0.5 text-[10px] uppercase tracking-wide">
                  {o.status.replace('_', ' ')}
                </span>
              </Link>
            ))}
          </div>
        )}
      </section>

      <section className="mt-10">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
          Jump into a product
        </h2>
        <div className="grid gap-3 md:grid-cols-4">
          <ProductLink href="/capture" name="Capture" desc="Pipeline, pursuits, tasks" />
          <ProductLink href="/proposal" name="Proposal" desc="AI drafting, compliance matrix" />
          <ProductLink href="/pricer" name="Pricer" desc="Labor categories, target value" />
          <ProductLink href="/contract" name="Contract" desc="Awards, obligations" />
          <ProductLink href="/past-performance" name="Past performance" desc="Reusable references" />
          <ProductLink href="/library" name="Content library" desc="Reusable proposal content" />
          <ProductLink href="/alerts" name="Alerts" desc="Saved opportunity searches" />
          <ProductLink href="/insights" name="Insights" desc="Win rate, pipeline health" />
        </div>
      </section>
    </main>
  );
}

function Fact({
  label,
  value,
  linkHref,
}: {
  label: string;
  value: number;
  linkHref?: string;
}) {
  const body = (
    <div>
      <p className="text-xs uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
        {label}
      </p>
      <p className="mt-1 text-2xl font-semibold">{value}</p>
    </div>
  );
  if (linkHref) {
    return (
      <Link href={linkHref} className="block hover:opacity-70">
        {body}
      </Link>
    );
  }
  return body;
}

function ProductLink({ href, name, desc }: { href: string; name: string; desc: string }) {
  return (
    <Link
      href={href}
      className="block rounded-[var(--radius-lg)] border border-[color:var(--color-border)] p-4 transition hover:border-[color:var(--color-foreground)]"
    >
      <p className="text-sm font-semibold">{name}</p>
      <p className="mt-1 text-xs text-[color:var(--color-muted-foreground)]">{desc}</p>
    </Link>
  );
}
