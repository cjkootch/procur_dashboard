import Link from 'next/link';
import type { PursuitCard as PursuitCardData } from '../../../lib/capture-queries';
import { flagFor, formatMoney } from '../../../lib/format';
import {
  chipClass,
  fundingChip,
  lifecycleChip,
  matchChip,
  preferenceChips,
  typeChip,
  type Chip,
} from '../../../lib/chips';

export function PursuitCard({ card }: { card: PursuitCardData }) {
  const op = card.opportunity;
  const value = formatMoney(op.valueEstimate, op.currency);
  const valueUsd = op.currency !== 'USD' ? formatMoney(op.valueEstimateUsd, 'USD') : null;
  const pWinPct = card.pWin != null ? Math.round(card.pWin * 100) : null;

  // Derive chips per the market-agnostic vocab in lib/chips.ts.
  // Order matters: lifecycle first (most urgent), then categorization.
  const chips: Chip[] = [];
  const lc = lifecycleChip(op.deadlineAt);
  if (lc) chips.push(lc);
  const tc = typeChip(op.type);
  if (tc) chips.push(tc);
  const fc = fundingChip(`${op.agencyName ?? ''} ${op.aiSummary ?? ''}`);
  if (fc) chips.push(fc);
  // Buyer-preference chips capped at 1 to keep the card compact.
  const prefChips = preferenceChips(`${op.agencyName ?? ''} ${op.aiSummary ?? ''}`);
  for (const p of prefChips.slice(0, 1)) chips.push(p);
  const mc = matchChip(card.pWin);

  return (
    <Link
      href={`/capture/pursuits/${card.id}`}
      className="block rounded-[var(--radius-md)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] p-3 transition hover:border-[color:var(--color-foreground)]/40 hover:shadow-sm"
    >
      <div className="mb-1.5 flex items-start gap-2">
        <span className="text-base leading-none">{flagFor(op.jurisdictionCountry)}</span>
        <p className="line-clamp-2 flex-1 text-[13px] font-medium leading-snug">{op.title}</p>
      </div>

      <p className="mb-2 text-[10px] uppercase tracking-wider text-[color:var(--color-muted-foreground)]">
        {op.agencyShort ?? op.agencyName ?? op.jurisdictionName}
        {op.referenceNumber && <span className="ml-1 normal-case">· {op.referenceNumber}</span>}
      </p>

      {chips.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1">
          {chips.map((c, i) => (
            <span
              key={`${c.label}-${i}`}
              title={c.title}
              className={`inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium ${chipClass(c.tone)}`}
            >
              {c.label}
            </span>
          ))}
        </div>
      )}

      {pWinPct != null && (
        <div className="mb-2">
          <div className="mb-0.5 flex items-baseline justify-between text-[10px] text-[color:var(--color-muted-foreground)]">
            <span>{mc?.label ?? `${pWinPct}% match`}</span>
            <span>P(Win)</span>
          </div>
          <div className="h-1 overflow-hidden rounded-full bg-[color:var(--color-muted)]/50">
            <div
              className={`h-full ${matchBarColor(pWinPct)}`}
              style={{ width: `${Math.min(100, pWinPct)}%` }}
            />
          </div>
        </div>
      )}

      <div className="flex items-center justify-between gap-2 text-[11px] text-[color:var(--color-muted-foreground)]">
        <div className="flex items-center gap-2">
          {card.assignedUserName ? (
            <span
              className="flex h-5 w-5 items-center justify-center rounded-full bg-[color:var(--color-foreground)]/10 text-[9px] font-medium uppercase text-[color:var(--color-foreground)]"
              title={`Assigned: ${card.assignedUserName}`}
            >
              {initials(card.assignedUserName)}
            </span>
          ) : (
            <span
              className="h-5 w-5 rounded-full border border-dashed border-[color:var(--color-border)]"
              title="Unassigned"
            />
          )}
          {card.tasks.openCount > 0 && (
            <span>
              {card.tasks.openCount} task{card.tasks.openCount === 1 ? '' : 's'}
              {card.tasks.overdueCount > 0 && (
                <span className="ml-1 text-red-600">({card.tasks.overdueCount} overdue)</span>
              )}
            </span>
          )}
        </div>
        {value && (
          <div className="text-right">
            <div className="font-medium text-[color:var(--color-foreground)]">{value}</div>
            {valueUsd && <div className="text-[10px]">≈ {valueUsd}</div>}
          </div>
        )}
      </div>
    </Link>
  );
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .map((p) => p[0] ?? '')
    .join('')
    .slice(0, 2)
    .toUpperCase();
}

function matchBarColor(pct: number): string {
  if (pct >= 75) return 'bg-emerald-500';
  if (pct >= 50) return 'bg-blue-500';
  if (pct >= 25) return 'bg-amber-500';
  return 'bg-[color:var(--color-muted-foreground)]/50';
}
