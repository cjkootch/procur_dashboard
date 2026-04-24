import Link from 'next/link';
import { requireCompany } from '@procur/auth';
import {
  getCompanyStageCounts,
  listCompanyPursuits,
  STAGE_LABEL,
  STAGE_ORDER,
  TERMINAL_STAGES,
  type PursuitStageKey,
} from '../../lib/capture-queries';
import { formatMoney } from '../../lib/format';
import { PursuitCard } from './components/pursuit-card';

export const dynamic = 'force-dynamic';

export default async function CaptureDashboardPage() {
  const { company } = await requireCompany();
  const [counts, pursuits] = await Promise.all([
    getCompanyStageCounts(company.id),
    listCompanyPursuits(company.id),
  ]);

  const active = pursuits.filter((p) => !TERMINAL_STAGES.includes(p.stage));
  const won = pursuits.filter((p) => p.stage === 'awarded').length;
  const lost = pursuits.filter((p) => p.stage === 'lost').length;
  const winRate = won + lost > 0 ? Math.round((won / (won + lost)) * 100) : null;

  const totalWeightedValue = active.reduce(
    (sum, p) => sum + (p.weightedValueUsd ?? 0),
    0,
  );
  const weightedFormatted = formatMoney(totalWeightedValue, 'USD');

  const recent = pursuits.slice(0, 6);

  return (
    <div className="mx-auto max-w-6xl px-8 py-10">
      <header className="mb-8 flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Capture</h1>
          <p className="mt-1 text-sm text-[color:var(--color-muted-foreground)]">
            {active.length} active pursuit{active.length === 1 ? '' : 's'}
          </p>
        </div>
        <Link
          href="/capture/pursuits"
          className="text-sm underline"
        >
          All pursuits →
        </Link>
      </header>

      <section className="mb-10 grid grid-cols-2 gap-4 md:grid-cols-4">
        <Stat label="Active" value={active.length.toString()} />
        <Stat
          label="Weighted pipeline"
          value={weightedFormatted ?? '—'}
          sub="Sum of value × P(Win)"
        />
        <Stat label="Won" value={won.toString()} />
        <Stat
          label="Win rate"
          value={winRate != null ? `${winRate}%` : '—'}
          sub="Lifetime"
        />
      </section>

      <section className="mb-10">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
          By stage
        </h2>
        <div className="grid grid-cols-2 gap-2 md:grid-cols-7">
          {STAGE_ORDER.map((stage) => (
            <StageCount
              key={stage}
              stage={stage}
              count={counts.get(stage) ?? 0}
            />
          ))}
        </div>
      </section>

      <section>
        <div className="mb-3 flex items-end justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
            Recently updated
          </h2>
          <Link href="/capture/pipeline" className="text-sm underline">
            View pipeline →
          </Link>
        </div>
        {recent.length === 0 ? (
          <EmptyState />
        ) : (
          <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
            {recent.map((p) => (
              <PursuitCard key={p.id} card={p} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function Stat({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="rounded-[var(--radius-lg)] border border-[color:var(--color-border)] p-4">
      <p className="text-xs uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
        {label}
      </p>
      <p className="mt-1 text-xl font-semibold">{value}</p>
      {sub && (
        <p className="mt-1 text-xs text-[color:var(--color-muted-foreground)]">{sub}</p>
      )}
    </div>
  );
}

function StageCount({ stage, count }: { stage: PursuitStageKey; count: number }) {
  return (
    <Link
      href={`/capture/pursuits?stage=${stage}`}
      className="rounded-[var(--radius-md)] border border-[color:var(--color-border)] p-3 text-center transition hover:border-[color:var(--color-foreground)]"
    >
      <p className="text-lg font-semibold">{count}</p>
      <p className="text-xs text-[color:var(--color-muted-foreground)]">{STAGE_LABEL[stage]}</p>
    </Link>
  );
}

function EmptyState() {
  return (
    <div className="rounded-[var(--radius-lg)] border border-dashed border-[color:var(--color-border)] p-10 text-center">
      <p className="font-medium">No pursuits yet</p>
      <p className="mt-2 text-sm text-[color:var(--color-muted-foreground)]">
        Start tracking an opportunity from{' '}
        <a
          className="underline"
          href={process.env.NEXT_PUBLIC_DISCOVER_URL ?? 'https://discover.procur.app'}
        >
          Discover
        </a>{' '}
        or by opportunity ID.
      </p>
    </div>
  );
}
