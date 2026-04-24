import { formatMoney } from '../../../lib/format';
import type {
  LaborCategoryCalculation,
  PricingSummary,
} from '../../../lib/pricer-queries';

/**
 * Line Items tab — basic auto-generated CLIN-style view of labor categories.
 *
 * Sprint A scope: read-only display + Labor vs Non-Labor / Base vs Options /
 * Fee split. Sprint B (P6) will add manual line-item editing, ODCs, and
 * proposal-export plumbing.
 */
export function LineItemsTab({
  summary,
  basePeriodMonths,
  currency,
  targetFeePct,
}: {
  summary: PricingSummary & { laborCategories: LaborCategoryCalculation[] };
  basePeriodMonths: number;
  currency: string;
  targetFeePct: number;
}) {
  const baseYears = Math.max(1, Math.ceil(basePeriodMonths / 12));

  // Split labor cost into Base vs Option Years using the per-LCAT yearly
  // breakdown so escalation is honored exactly.
  let baseCost = 0;
  let optionCost = 0;
  for (const c of summary.laborCategories) {
    for (const yb of c.yearlyBreakdown) {
      if (yb.year <= baseYears) baseCost += yb.cost;
      else optionCost += yb.cost;
    }
  }

  return (
    <div className="space-y-4">
      <section className="grid gap-3 md:grid-cols-3">
        <Stat
          label="Total Contract Value"
          value={formatMoney(summary.totalValue, currency) ?? '—'}
          sub={`${summary.periodYears} years`}
        />
        <Stat
          label="Labor vs Non-Labor"
          value={formatMoney(summary.totalLaborCost, currency) ?? '—'}
          sub={`Other (ODCs, Travel, Materials): ${formatMoney(0, currency) ?? '$0'}`}
        />
        <Stat
          label="Base vs Options"
          value={formatMoney(baseCost, currency) ?? '—'}
          sub={`Option Years: ${formatMoney(optionCost, currency) ?? '$0'}`}
        />
      </section>

      <section className="rounded-[var(--radius-md)] border border-[color:var(--color-border)] bg-[color:var(--color-background)]">
        <header className="flex items-center justify-between border-b border-[color:var(--color-border)] px-5 py-3">
          <div>
            <h2 className="text-sm font-semibold">Labor Categories (Auto-Calculated)</h2>
            <p className="mt-0.5 text-[11px] text-[color:var(--color-muted-foreground)]">
              CLIN-style line items derived from the Labor Categories tab. Edit there to update.
            </p>
          </div>
          <p className="text-[11px] text-[color:var(--color-muted-foreground)]">
            Fee / Profit:{' '}
            <span className="font-medium text-[color:var(--color-foreground)]">
              {targetFeePct.toFixed(1)}%
            </span>{' '}
            · {formatMoney(summary.targetFee, currency) ?? '—'}
          </p>
        </header>

        {summary.laborCategories.length === 0 ? (
          <p className="p-6 text-center text-sm text-[color:var(--color-muted-foreground)]">
            No labor categories yet. Add them on the Labor Categories tab.
          </p>
        ) : (
          <table className="w-full text-left text-sm">
            <thead className="border-b border-[color:var(--color-border)] text-[11px] uppercase tracking-wider text-[color:var(--color-muted-foreground)]">
              <tr>
                <th className="px-4 py-2">CLIN</th>
                <th className="px-4 py-2">Labor Category</th>
                <th className="px-4 py-2 text-right">Hours ({summary.periodYears}y)</th>
                <th className="px-4 py-2 text-right">Base Rate</th>
                <th className="px-4 py-2 text-right">Burdened Rate</th>
                <th className="px-4 py-2 text-right">Extended Cost</th>
              </tr>
            </thead>
            <tbody>
              {summary.laborCategories.map((c, i) => (
                <tr key={c.id} className="border-t border-[color:var(--color-border)]">
                  <td className="px-4 py-2 font-mono text-xs text-[color:var(--color-muted-foreground)]">
                    0001-{String(i + 1).padStart(2, '0')}
                  </td>
                  <td className="px-4 py-2 font-medium">{c.title}</td>
                  <td className="px-4 py-2 text-right">
                    {(c.hoursPerYear * summary.periodYears).toLocaleString()}
                  </td>
                  <td className="px-4 py-2 text-right">
                    {formatMoney(c.directRate, currency) ?? '—'}/hr
                  </td>
                  <td className="px-4 py-2 text-right">
                    {formatMoney(c.loadedRate, currency) ?? '—'}/hr
                  </td>
                  <td className="px-4 py-2 text-right font-semibold">
                    {formatMoney(c.totalCost, currency) ?? '—'}
                  </td>
                </tr>
              ))}
              <tr className="border-t-2 border-[color:var(--color-foreground)] bg-[color:var(--color-muted)]/30 text-sm font-semibold">
                <td className="px-4 py-2" colSpan={5}>
                  Subtotal — Labor
                </td>
                <td className="px-4 py-2 text-right">
                  {formatMoney(summary.totalLaborCost, currency) ?? '—'}
                </td>
              </tr>
              <tr className="border-t border-[color:var(--color-border)] text-sm">
                <td className="px-4 py-2" colSpan={5}>
                  Fee / Profit ({targetFeePct.toFixed(1)}%)
                </td>
                <td className="px-4 py-2 text-right">
                  {formatMoney(summary.targetFee, currency) ?? '—'}
                </td>
              </tr>
              <tr className="border-t-2 border-[color:var(--color-foreground)] bg-[color:var(--color-muted)]/40 text-sm font-bold">
                <td className="px-4 py-2" colSpan={5}>
                  Total Contract Value
                </td>
                <td className="px-4 py-2 text-right">
                  {formatMoney(summary.totalValue, currency) ?? '—'}
                </td>
              </tr>
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-[var(--radius-md)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] p-4">
      <p className="text-[11px] uppercase tracking-wider text-[color:var(--color-muted-foreground)]">
        {label}
      </p>
      <p className="mt-1 text-lg font-semibold">{value}</p>
      {sub && (
        <p className="mt-0.5 text-[11px] text-[color:var(--color-muted-foreground)]">{sub}</p>
      )}
    </div>
  );
}
