import type { PursuitCard } from '../../../../lib/capture-queries';
import { formatDate, formatMoney, timeUntil } from '../../../../lib/format';

/**
 * Overview tab — read-only summary of the pursuit + its underlying
 * opportunity. The right rail carries the editable controls (P(Win),
 * notes, stage advancement), so this tab stays clean for scanning.
 */
export function PursuitOverviewTab({
  card,
  rawAiSummary,
  rawDescription,
}: {
  card: PursuitCard;
  rawAiSummary: string | null;
  rawDescription: string | null;
}) {
  const op = card.opportunity;
  const countdown = timeUntil(op.deadlineAt);

  return (
    <div className="space-y-4">
      <section className="grid gap-3 rounded-[var(--radius-md)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] p-5 md:grid-cols-4">
        <Fact label="Stage" value={card.stage.replace(/_/g, ' ')} />
        <Fact
          label="Closes"
          value={op.deadlineAt ? formatDate(op.deadlineAt) : '—'}
          sub={countdown && countdown !== 'closed' ? `in ${countdown}` : undefined}
        />
        <Fact
          label="Value"
          value={formatMoney(op.valueEstimate, op.currency) ?? '—'}
          sub={
            op.valueEstimateUsd && op.currency !== 'USD'
              ? `≈ ${formatMoney(op.valueEstimateUsd, 'USD')}`
              : undefined
          }
        />
        <Fact
          label="P(Win)"
          value={card.pWin != null ? `${Math.round(card.pWin * 100)}%` : '—'}
          sub={card.weightedValueUsd != null ? `Weighted ${formatMoney(card.weightedValueUsd, 'USD')}` : undefined}
        />
      </section>

      {rawAiSummary && (
        <section className="rounded-[var(--radius-md)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] p-5">
          <h2 className="mb-2 text-sm font-semibold">AI summary</h2>
          <p className="text-sm leading-relaxed">{rawAiSummary}</p>
        </section>
      )}

      {rawDescription && (
        <section className="rounded-[var(--radius-md)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] p-5">
          <h2 className="mb-2 text-sm font-semibold">Opportunity description</h2>
          <p className="max-h-96 overflow-y-auto whitespace-pre-wrap text-sm leading-relaxed text-[color:var(--color-muted-foreground)]">
            {rawDescription}
          </p>
        </section>
      )}

      {card.notes && (
        <section className="rounded-[var(--radius-md)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] p-5">
          <h2 className="mb-2 text-sm font-semibold">Internal notes</h2>
          <p className="whitespace-pre-wrap text-sm">{card.notes}</p>
          <p className="mt-2 text-[10px] text-[color:var(--color-muted-foreground)]">
            Edit in the right-side panel.
          </p>
        </section>
      )}
    </div>
  );
}

function Fact({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div>
      <p className="text-[11px] uppercase tracking-wider text-[color:var(--color-muted-foreground)]">
        {label}
      </p>
      <p className="mt-1 text-base font-semibold capitalize">{value}</p>
      {sub && (
        <p className="mt-0.5 text-[11px] text-[color:var(--color-muted-foreground)]">{sub}</p>
      )}
    </div>
  );
}
