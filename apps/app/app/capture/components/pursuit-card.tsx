import Link from 'next/link';
import type { PursuitCard as PursuitCardData } from '../../../lib/capture-queries';
import { flagFor, formatMoney, timeUntil } from '../../../lib/format';

export function PursuitCard({ card }: { card: PursuitCardData }) {
  const op = card.opportunity;
  const value = formatMoney(op.valueEstimate, op.currency);
  const valueUsd = op.currency !== 'USD' ? formatMoney(op.valueEstimateUsd, 'USD') : null;
  const countdown = timeUntil(op.deadlineAt);
  const pWinPct =
    card.pWin != null ? `${Math.round(card.pWin * 100)}%` : '—';

  return (
    <Link
      href={`/capture/pursuits/${card.id}`}
      className="block rounded-[var(--radius-lg)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] p-4 transition hover:border-[color:var(--color-foreground)]"
    >
      <div className="mb-2 flex items-start justify-between gap-2">
        <span className="text-base leading-none">{flagFor(op.jurisdictionCountry)}</span>
        {countdown && (
          <span
            className={`text-xs font-medium ${
              countdown === 'closed'
                ? 'text-[color:var(--color-muted-foreground)]'
                : 'text-[color:var(--color-brand)]'
            }`}
          >
            {countdown === 'closed' ? 'Closed' : countdown}
          </span>
        )}
      </div>
      <p className="mb-1 line-clamp-2 text-sm font-medium leading-snug">{op.title}</p>
      <p className="text-xs text-[color:var(--color-muted-foreground)]">
        {op.agencyShort ?? op.agencyName ?? op.jurisdictionName}
      </p>
      <div className="mt-3 flex items-center justify-between text-xs">
        <div className="flex gap-3 text-[color:var(--color-muted-foreground)]">
          <span>P(Win): {pWinPct}</span>
          {card.tasks.openCount > 0 && (
            <span>
              {card.tasks.openCount} task{card.tasks.openCount === 1 ? '' : 's'}
              {card.tasks.overdueCount > 0 && (
                <span className="ml-1 text-[color:var(--color-brand)]">
                  ({card.tasks.overdueCount} overdue)
                </span>
              )}
            </span>
          )}
        </div>
        {value && (
          <div className="text-right">
            <div className="font-medium">{value}</div>
            {valueUsd && (
              <div className="text-[color:var(--color-muted-foreground)]">≈ {valueUsd}</div>
            )}
          </div>
        )}
      </div>
    </Link>
  );
}
