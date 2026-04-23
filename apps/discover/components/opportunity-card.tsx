import Link from 'next/link';
import type { OpportunitySummary } from '../lib/queries';
import { flagFor } from '../lib/flags';
import { formatMoney, timeUntil } from '../lib/format';

type Props = { op: OpportunitySummary };

export function OpportunityCard({ op }: Props) {
  const href = `/opportunities/${op.slug}`;
  const value = formatMoney(op.valueEstimate, op.currency);
  const valueUsd = op.currency !== 'USD' ? formatMoney(op.valueEstimateUsd, 'USD') : null;
  const countdown = timeUntil(op.deadlineAt);

  return (
    <article className="flex flex-col gap-3 rounded-[var(--radius-lg)] border border-[color:var(--color-border)] p-5 transition hover:border-[color:var(--color-foreground)]">
      <header className="flex items-start justify-between gap-3">
        <span
          title={op.jurisdictionName}
          aria-label={op.jurisdictionName}
          className="text-xl leading-none"
        >
          {flagFor(op.jurisdictionCountry)}
        </span>
        {countdown && (
          <span
            className={`text-xs font-medium ${
              countdown === 'closed'
                ? 'text-[color:var(--color-muted-foreground)]'
                : 'text-[color:var(--color-brand)]'
            }`}
          >
            {countdown === 'closed' ? 'Closed' : `Closes in ${countdown}`}
          </span>
        )}
      </header>

      <Link href={href} className="block">
        <h3 className="text-base font-semibold leading-snug group-hover:underline">{op.title}</h3>
      </Link>

      {op.aiSummary ? (
        <p className="line-clamp-3 text-sm text-[color:var(--color-muted-foreground)]">
          {op.aiSummary}
        </p>
      ) : op.description ? (
        <p className="line-clamp-3 text-sm text-[color:var(--color-muted-foreground)]">
          {op.description}
        </p>
      ) : null}

      <footer className="mt-auto flex flex-wrap items-end justify-between gap-3 pt-2 text-xs">
        <div className="text-[color:var(--color-muted-foreground)]">
          {op.agencyShort ?? op.agencyName ?? op.jurisdictionName}
          {op.referenceNumber && <span> · {op.referenceNumber}</span>}
        </div>
        {value && (
          <div className="text-right">
            <div className="font-medium text-[color:var(--color-foreground)]">{value}</div>
            {valueUsd && <div className="text-[color:var(--color-muted-foreground)]">≈ {valueUsd}</div>}
          </div>
        )}
      </footer>
    </article>
  );
}
