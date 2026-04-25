import Link from 'next/link';
import { requireCompany } from '@procur/auth';
import { getInsights } from '../../lib/insights-queries';
import { flagFor, formatMoney } from '../../lib/format';

export const dynamic = 'force-dynamic';

function formatUsd(value: number): string {
  return formatMoney(value, 'USD') ?? '$0';
}

export default async function InsightsPage() {
  const { company } = await requireCompany();
  const i = await getInsights(company.id);

  const maxStageCount = Math.max(1, ...i.stageBreakdown.map((s) => s.count));
  const maxCategoryCount = Math.max(1, ...i.topCategories.map((c) => c.pursuitCount));

  return (
    <div className="mx-auto max-w-6xl px-8 py-10">
      <header className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Insights</h1>
          <p className="mt-1 text-sm text-[color:var(--color-muted-foreground)]">
            Snapshot of your pipeline, wins, and library assets. Updates in real time as you
            progress pursuits.
          </p>
        </div>
        <a
          href="/api/insights/export.csv"
          className="rounded-[var(--radius-md)] border border-[color:var(--color-border)] px-3 py-1.5 text-xs font-medium hover:bg-[color:var(--color-muted)]/40"
        >
          Download .csv
        </a>
      </header>

      <section className="mb-10 grid gap-4 rounded-[var(--radius-lg)] border border-[color:var(--color-border)] p-6 md:grid-cols-4">
        <Fact
          label="Open pipeline"
          value={formatUsd(i.pipelineValueUsd)}
          sub={`${i.activePursuits} active pursuit${i.activePursuits === 1 ? '' : 's'}`}
        />
        <Fact
          label="Weighted pipeline"
          value={formatUsd(i.weightedPipelineUsd)}
          sub="Pipeline × P(Win)"
        />
        <Fact
          label="Win rate"
          value={`${Math.round(i.winRate * 100)}%`}
          sub={`${i.awardedCount} won · ${i.lostCount} lost`}
        />
        <Fact
          label="Won value"
          value={formatUsd(i.wonValueUsd)}
          sub={`${i.awardedCount} award${i.awardedCount === 1 ? '' : 's'}`}
        />
      </section>

      <section className="mb-10">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
          Pipeline by stage
        </h2>
        <div className="space-y-2 rounded-[var(--radius-lg)] border border-[color:var(--color-border)] p-5">
          {i.stageBreakdown.map((s) => (
            <div key={s.stage} className="grid grid-cols-[160px_1fr_90px_140px] items-center gap-3 text-sm">
              <span className="text-[color:var(--color-muted-foreground)]">{s.label}</span>
              <div className="h-3 rounded-full bg-[color:var(--color-muted)]/40">
                <div
                  className="h-3 rounded-full bg-[color:var(--color-foreground)]"
                  style={{ width: `${Math.round((s.count / maxStageCount) * 100)}%` }}
                />
              </div>
              <span className="text-right font-medium">{s.count}</span>
              <span className="text-right text-xs text-[color:var(--color-muted-foreground)]">
                {formatUsd(s.totalValueUsd)}
              </span>
            </div>
          ))}
        </div>
      </section>

      <div className="grid gap-6 md:grid-cols-2">
        <section>
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
            Top jurisdictions
          </h2>
          <div className="rounded-[var(--radius-lg)] border border-[color:var(--color-border)] p-4">
            {i.topJurisdictions.length === 0 ? (
              <p className="text-xs text-[color:var(--color-muted-foreground)]">
                No pursuits yet.
              </p>
            ) : (
              <div className="space-y-2 text-sm">
                {i.topJurisdictions.map((j) => (
                  <div key={j.name} className="flex items-center gap-3">
                    <span className="text-xl">{flagFor(j.countryCode)}</span>
                    <span className="flex-1">{j.name}</span>
                    <span className="text-xs text-[color:var(--color-muted-foreground)]">
                      {j.wonCount} won
                    </span>
                    <span className="text-sm font-medium">{j.pursuitCount}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>

        <section>
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
            Top categories
          </h2>
          <div className="rounded-[var(--radius-lg)] border border-[color:var(--color-border)] p-4">
            {i.topCategories.length === 0 ? (
              <p className="text-xs text-[color:var(--color-muted-foreground)]">
                No tagged categories yet.
              </p>
            ) : (
              <div className="space-y-2 text-sm">
                {i.topCategories.map((c) => (
                  <div key={c.category} className="grid grid-cols-[1fr_80px_50px] items-center gap-3">
                    <span className="truncate">{c.category}</span>
                    <div className="h-2 rounded-full bg-[color:var(--color-muted)]/40">
                      <div
                        className="h-2 rounded-full bg-[color:var(--color-foreground)]"
                        style={{ width: `${Math.round((c.pursuitCount / maxCategoryCount) * 100)}%` }}
                      />
                    </div>
                    <span className="text-right font-medium">{c.pursuitCount}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>
      </div>

      <section className="mt-10 grid gap-4 rounded-[var(--radius-lg)] border border-[color:var(--color-border)] p-6 md:grid-cols-3">
        <Fact
          label="Contracts"
          value={i.contractCount.toString()}
          sub={`${formatUsd(i.activeContractValueUsd)} active`}
          linkHref="/contract"
        />
        <Fact
          label="Past performance"
          value={i.pastPerformanceCount.toString()}
          sub="References in library"
          linkHref="/past-performance"
        />
        <Fact
          label="Total pursuits"
          value={i.totalPursuits.toString()}
          sub={`${i.activePursuits} still open`}
          linkHref="/capture/pursuits"
        />
      </section>
    </div>
  );
}

function Fact({
  label,
  value,
  sub,
  linkHref,
}: {
  label: string;
  value: string;
  sub?: string;
  linkHref?: string;
}) {
  const body = (
    <div>
      <p className="text-xs uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
        {label}
      </p>
      <p className="mt-1 text-base font-semibold">{value}</p>
      {sub && <p className="text-xs text-[color:var(--color-muted-foreground)]">{sub}</p>}
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
