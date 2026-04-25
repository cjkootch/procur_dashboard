import Link from 'next/link';
import { requireCompany } from '@procur/auth';
import { listPricerPursuits, type PricerListRow } from '../../lib/pricer-queries';
import { flagFor, formatDate, formatMoney, timeUntil } from '../../lib/format';

export const dynamic = 'force-dynamic';

export default async function PricerListPage() {
  const { company } = await requireCompany();
  const rows = await listPricerPursuits(company.id);

  const started = rows.filter((r) => r.pricingModelId);
  const available = rows.filter((r) => !r.pricingModelId);

  // When the company has zero pursuits in any pricable stage, the
  // page is a flat dead-end — show the user where to start instead of
  // two empty card lists.
  const hasAnyPricable = available.length > 0 || started.length > 0;

  return (
    <div className="mx-auto max-w-5xl px-8 py-10">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Pricer</h1>
        <p className="mt-1 text-sm text-[color:var(--color-muted-foreground)]">
          Cost estimation models for each pursuit. Labor category modeling, indirect rates,
          multi-year escalation, auto-calculated target value.
        </p>
      </header>

      {!hasAnyPricable && (
        <div className="rounded-[var(--radius-lg)] border border-dashed border-[color:var(--color-border)] p-10 text-center">
          <p className="font-medium">Nothing to price yet</p>
          <p className="mt-2 text-sm text-[color:var(--color-muted-foreground)]">
            The pricer activates once you have a pursuit in capture planning or
            later. Move a pursuit forward to start modeling cost.
          </p>
          <div className="mt-4 flex justify-center gap-2">
            <Link
              href="/capture/pipeline"
              className="rounded-[var(--radius-md)] bg-[color:var(--color-foreground)] px-4 py-2 text-sm font-medium text-[color:var(--color-background)]"
            >
              Open pipeline
            </Link>
            <Link
              href="/capture/pursuits"
              className="rounded-[var(--radius-md)] border border-[color:var(--color-border)] px-4 py-2 text-sm font-medium hover:bg-[color:var(--color-muted)]/40"
            >
              All pursuits
            </Link>
          </div>
        </div>
      )}

      {available.length > 0 && (
        <section className="mb-10">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
            Ready to price ({available.length})
          </h2>
          <div className="space-y-2">
            {available.map((r) => (
              <Row key={r.pursuitId} row={r} />
            ))}
          </div>
        </section>
      )}

      {hasAnyPricable && (
        <section>
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
            In progress ({started.length})
          </h2>
          {started.length === 0 ? (
            <div className="rounded-[var(--radius-lg)] border border-dashed border-[color:var(--color-border)] p-10 text-center text-sm text-[color:var(--color-muted-foreground)]">
              No pricing models started yet — pick a pursuit above to start one.
            </div>
          ) : (
            <div className="space-y-2">
              {started.map((r) => (
                <Row key={r.pursuitId} row={r} />
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
}

function Row({ row }: { row: PricerListRow }) {
  const countdown = timeUntil(row.deadlineAt);
  const targetValue = formatMoney(row.targetValue, row.currency);
  return (
    <Link
      href={`/pricer/${row.pursuitId}`}
      className="flex items-center gap-4 rounded-[var(--radius-lg)] border border-[color:var(--color-border)] p-4 transition hover:border-[color:var(--color-foreground)]"
    >
      <span className="text-xl">{flagFor(row.jurisdictionCountry)}</span>
      <div className="flex-1">
        <p className="text-sm font-medium">{row.opportunityTitle}</p>
        <p className="mt-0.5 text-xs text-[color:var(--color-muted-foreground)]">
          {row.agencyName ?? row.jurisdictionName}
          {row.deadlineAt && <> · Closes {formatDate(row.deadlineAt)}</>}
          {countdown && countdown !== 'closed' && <> · in {countdown}</>}
        </p>
      </div>
      <div className="text-right text-xs">
        {row.pricingModelId ? (
          <>
            <p className="font-medium">{targetValue ?? 'Target —'}</p>
            <p className="text-[color:var(--color-muted-foreground)]">
              {row.laborCategoriesCount} labor cat{row.laborCategoriesCount === 1 ? '' : 's'}
            </p>
          </>
        ) : (
          <p className="text-[color:var(--color-brand)]">Price →</p>
        )}
      </div>
    </Link>
  );
}
