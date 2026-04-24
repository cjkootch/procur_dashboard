import Link from 'next/link';
import { requireCompany } from '@procur/auth';
import {
  listConvertibleContracts,
  listPastPerformance,
  type PastPerformanceListRow,
} from '../../lib/past-performance-queries';
import { formatDate, formatMoney } from '../../lib/format';
import { generateFromContractAction } from './actions';

export const dynamic = 'force-dynamic';

export default async function PastPerformancePage() {
  const { company } = await requireCompany();
  const [entries, candidates] = await Promise.all([
    listPastPerformance(company.id),
    listConvertibleContracts(company.id),
  ]);
  const ready = candidates.filter((c) => !c.hasPastPerformance);

  return (
    <div className="mx-auto max-w-5xl px-8 py-10">
      <header className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Past performance</h1>
          <p className="mt-1 text-sm text-[color:var(--color-muted-foreground)]">
            Library of corporate references. Proposals can cite these for relevant experience
            narratives. Generate entries from completed contracts in one click.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <a
            href="/api/past-performance/export.csv"
            className="rounded-[var(--radius-md)] border border-[color:var(--color-border)] px-3 py-1.5 text-sm font-medium hover:bg-[color:var(--color-muted)]/40"
          >
            Download .csv
          </a>
          <Link
            href="/past-performance/new"
            className="rounded-[var(--radius-md)] bg-[color:var(--color-foreground)] px-4 py-2 text-sm font-medium text-[color:var(--color-background)]"
          >
            New entry
          </Link>
        </div>
      </header>

      {ready.length > 0 && (
        <section className="mb-8">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
            Generate from contract ({ready.length})
          </h2>
          <div className="space-y-2">
            {ready.map((c) => (
              <div
                key={c.id}
                className="flex items-center gap-4 rounded-[var(--radius-lg)] border border-dashed border-[color:var(--color-border)] p-4"
              >
                <div className="flex-1">
                  <p className="text-sm font-medium">{c.awardTitle}</p>
                  <p className="mt-0.5 text-xs text-[color:var(--color-muted-foreground)]">
                    {c.awardingAgency ?? '—'}
                    {c.totalValue && <> · {formatMoney(c.totalValue, c.currency) ?? ''}</>}
                    {c.endDate && <> · ended {formatDate(new Date(c.endDate))}</>}
                  </p>
                </div>
                <form action={generateFromContractAction}>
                  <input type="hidden" name="contractId" value={c.id} />
                  <button
                    type="submit"
                    className="rounded-[var(--radius-md)] border border-[color:var(--color-border)] px-3 py-1.5 text-xs font-medium hover:bg-[color:var(--color-muted)]/40"
                  >
                    Generate →
                  </button>
                </form>
              </div>
            ))}
          </div>
        </section>
      )}

      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
          Entries ({entries.length})
        </h2>
        {entries.length === 0 ? (
          <div className="rounded-[var(--radius-lg)] border border-dashed border-[color:var(--color-border)] p-10 text-center text-sm text-[color:var(--color-muted-foreground)]">
            No past performance entries yet. Generate one from a completed contract, or add
            manually for legacy work.
          </div>
        ) : (
          <div className="space-y-2">
            {entries.map((e) => (
              <Row key={e.id} row={e} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function Row({ row }: { row: PastPerformanceListRow }) {
  const value = formatMoney(row.totalValue, row.currency);
  return (
    <Link
      href={`/past-performance/${row.id}`}
      className="flex items-center gap-4 rounded-[var(--radius-lg)] border border-[color:var(--color-border)] p-4 transition hover:border-[color:var(--color-foreground)]"
    >
      <div className="flex-1">
        <p className="text-sm font-medium">{row.projectName}</p>
        <p className="mt-0.5 text-xs text-[color:var(--color-muted-foreground)]">
          {row.customerName}
          {row.periodStart && row.periodEnd && (
            <>
              {' '}
              · {formatDate(new Date(row.periodStart))} → {formatDate(new Date(row.periodEnd))}
            </>
          )}
        </p>
      </div>
      <div className="text-right text-xs">
        <p className="font-medium">{value ?? '—'}</p>
        {row.categoryCount > 0 && (
          <p className="text-[color:var(--color-muted-foreground)]">
            {row.categoryCount} categor{row.categoryCount === 1 ? 'y' : 'ies'}
          </p>
        )}
      </div>
    </Link>
  );
}
