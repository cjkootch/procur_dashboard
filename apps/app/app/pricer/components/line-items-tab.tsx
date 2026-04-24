import { LINE_ITEM_CATEGORIES, type LineItemCategory, type PricingLineItem } from '@procur/db';
import { formatMoney } from '../../../lib/format';
import {
  lineItemAmount,
  summarizeLineItems,
  type LaborCategoryCalculation,
  type PricingSummary,
} from '../../../lib/pricer-queries';
import {
  addLineItemAction,
  removeLineItemAction,
  updateLineItemAction,
} from '../actions';

const CATEGORY_LABEL: Record<LineItemCategory, string> = {
  odc: 'ODC',
  travel: 'Travel',
  materials: 'Materials',
  subcontract: 'Subcontract',
  other: 'Other',
};

/**
 * Line Items tab. Two sections:
 *   1. Labor (auto-calculated)  — read-only rows derived from the Labor
 *                                 Categories tab via summary.laborCategories
 *   2. Non-labor line items     — ODC / travel / materials / subcontract /
 *                                 other. Editable per-row, with an add form
 *                                 below the table
 *
 * Totals at the top show contract value now inclusive of non-labor line
 * items so the Pricer hero stays coherent with what CLINs say.
 */
export function LineItemsTab({
  summary,
  basePeriodMonths,
  currency,
  targetFeePct,
  pursuitId,
  lineItems,
}: {
  summary: PricingSummary & { laborCategories: LaborCategoryCalculation[] };
  basePeriodMonths: number;
  currency: string;
  targetFeePct: number;
  pursuitId: string;
  lineItems: PricingLineItem[];
}) {
  const baseYears = Math.max(1, Math.ceil(basePeriodMonths / 12));

  // Labor: split base vs options via per-LCAT yearly breakdown so
  // escalation is honored exactly.
  let laborBase = 0;
  let laborOption = 0;
  for (const c of summary.laborCategories) {
    for (const yb of c.yearlyBreakdown) {
      if (yb.year <= baseYears) laborBase += yb.cost;
      else laborOption += yb.cost;
    }
  }

  const lineItemSummary = summarizeLineItems(lineItems);
  const nonLaborTotal = lineItemSummary.nonLaborTotal;

  // Fee is still calculated on labor cost only — non-labor line items
  // are typically pass-through (no fee). Teams who want fee on ODCs
  // should set the fee % appropriately and include labor-equivalent
  // lines; we can relax this rule when P8 (custom indirects) ships.
  const totalWithNonLabor = summary.totalValue + nonLaborTotal;

  return (
    <div className="space-y-4">
      <section className="grid gap-3 md:grid-cols-4">
        <Stat
          label="Total Contract Value"
          value={formatMoney(totalWithNonLabor, currency) ?? '—'}
          sub={`${summary.periodYears} years · fee on labor only`}
        />
        <Stat
          label="Labor"
          value={formatMoney(summary.totalLaborCost, currency) ?? '—'}
          sub={`Base ${formatMoney(laborBase, currency) ?? '$0'} · Options ${formatMoney(laborOption, currency) ?? '$0'}`}
        />
        <Stat
          label="Non-labor"
          value={formatMoney(nonLaborTotal, currency) ?? '—'}
          sub={lineItemBreakdownHint(lineItemSummary.byCategory)}
        />
        <Stat
          label={`Fee / profit (${targetFeePct.toFixed(1)}%)`}
          value={formatMoney(summary.targetFee, currency) ?? '—'}
        />
      </section>

      {/* --- Labor (auto-calculated) ---------------------------------------- */}
      <section className="rounded-[var(--radius-md)] border border-[color:var(--color-border)] bg-[color:var(--color-background)]">
        <header className="flex items-center justify-between border-b border-[color:var(--color-border)] px-5 py-3">
          <div>
            <h2 className="text-sm font-semibold">Labor CLINs (auto-calculated)</h2>
            <p className="mt-0.5 text-[11px] text-[color:var(--color-muted-foreground)]">
              Derived from the Labor Categories tab × wrap rate × escalation.
              Edit there to update.
            </p>
          </div>
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
            </tbody>
          </table>
        )}
      </section>

      {/* --- Non-labor line items (editable) ------------------------------- */}
      <section className="rounded-[var(--radius-md)] border border-[color:var(--color-border)] bg-[color:var(--color-background)]">
        <header className="flex items-center justify-between border-b border-[color:var(--color-border)] px-5 py-3">
          <div>
            <h2 className="text-sm font-semibold">
              Non-labor line items ({lineItems.length})
            </h2>
            <p className="mt-0.5 text-[11px] text-[color:var(--color-muted-foreground)]">
              ODCs, travel, materials, subcontracts. Amount = quantity × unit
              price unless a manual amount is set.
            </p>
          </div>
        </header>

        {lineItems.length === 0 ? (
          <p className="p-6 text-center text-sm text-[color:var(--color-muted-foreground)]">
            No non-labor line items yet. Add one below.
          </p>
        ) : (
          <table className="w-full text-left text-sm">
            <thead className="border-b border-[color:var(--color-border)] text-[11px] uppercase tracking-wider text-[color:var(--color-muted-foreground)]">
              <tr>
                <th className="px-4 py-2">CLIN</th>
                <th className="px-4 py-2">Title</th>
                <th className="px-4 py-2">Category</th>
                <th className="px-4 py-2 text-right">Qty</th>
                <th className="px-4 py-2 text-right">Unit price</th>
                <th className="px-4 py-2 text-right">Amount</th>
                <th className="px-4 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {lineItems.map((li) => (
                <LineItemRow
                  key={li.id}
                  li={li}
                  pursuitId={pursuitId}
                  currency={currency}
                />
              ))}
              <tr className="border-t-2 border-[color:var(--color-foreground)] bg-[color:var(--color-muted)]/30 text-sm font-semibold">
                <td className="px-4 py-2" colSpan={6}>
                  Subtotal — Non-labor
                </td>
                <td className="px-4 py-2 text-right">
                  {formatMoney(nonLaborTotal, currency) ?? '—'}
                </td>
              </tr>
            </tbody>
          </table>
        )}

        {/* Add form */}
        <form
          action={addLineItemAction}
          className="flex flex-wrap items-end gap-2 border-t border-[color:var(--color-border)] p-4 text-xs"
        >
          <input type="hidden" name="pursuitId" value={pursuitId} />
          <label className="flex flex-col gap-1">
            <span className="text-[10px] uppercase tracking-wider text-[color:var(--color-muted-foreground)]">
              CLIN
            </span>
            <input
              name="clinNumber"
              placeholder="0002"
              className="w-20 rounded-[var(--radius-sm)] border border-[color:var(--color-border)] px-2 py-1 text-xs font-mono"
            />
          </label>
          <label className="flex flex-1 min-w-[160px] flex-col gap-1">
            <span className="text-[10px] uppercase tracking-wider text-[color:var(--color-muted-foreground)]">
              Title
            </span>
            <input
              name="title"
              required
              placeholder="Travel to Kingston · Materials · Subcontract to X…"
              className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] px-2 py-1 text-xs"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[10px] uppercase tracking-wider text-[color:var(--color-muted-foreground)]">
              Category
            </span>
            <select
              name="category"
              defaultValue="odc"
              className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1 text-xs"
            >
              {LINE_ITEM_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {CATEGORY_LABEL[c]}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[10px] uppercase tracking-wider text-[color:var(--color-muted-foreground)]">
              Qty
            </span>
            <input
              name="quantity"
              type="number"
              step="0.01"
              placeholder="1"
              className="w-20 rounded-[var(--radius-sm)] border border-[color:var(--color-border)] px-2 py-1 text-right text-xs"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[10px] uppercase tracking-wider text-[color:var(--color-muted-foreground)]">
              Unit price
            </span>
            <input
              name="unitPrice"
              type="number"
              step="0.01"
              placeholder="0.00"
              className="w-24 rounded-[var(--radius-sm)] border border-[color:var(--color-border)] px-2 py-1 text-right text-xs"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[10px] uppercase tracking-wider text-[color:var(--color-muted-foreground)]">
              Or amount
            </span>
            <input
              name="amount"
              type="number"
              step="0.01"
              placeholder="0.00"
              className="w-24 rounded-[var(--radius-sm)] border border-[color:var(--color-border)] px-2 py-1 text-right text-xs"
            />
          </label>
          <button
            type="submit"
            className="rounded-[var(--radius-sm)] bg-[color:var(--color-foreground)] px-3 py-1.5 text-xs font-medium text-[color:var(--color-background)]"
          >
            + Add
          </button>
        </form>
      </section>

      {/* --- Grand total ----------------------------------------------------- */}
      <section className="rounded-[var(--radius-md)] border-2 border-[color:var(--color-foreground)] bg-[color:var(--color-muted)]/40 p-4">
        <div className="flex items-baseline justify-between">
          <span className="text-sm font-semibold">Total Contract Value</span>
          <span className="text-lg font-bold">
            {formatMoney(totalWithNonLabor, currency) ?? '—'}
          </span>
        </div>
        <div className="mt-2 grid grid-cols-3 gap-2 text-[11px] text-[color:var(--color-muted-foreground)]">
          <div>
            Labor: <span className="font-medium text-[color:var(--color-foreground)]">{formatMoney(summary.totalLaborCost, currency) ?? '—'}</span>
          </div>
          <div>
            Non-labor: <span className="font-medium text-[color:var(--color-foreground)]">{formatMoney(nonLaborTotal, currency) ?? '—'}</span>
          </div>
          <div>
            Fee: <span className="font-medium text-[color:var(--color-foreground)]">{formatMoney(summary.targetFee, currency) ?? '—'}</span>
          </div>
        </div>
      </section>
    </div>
  );
}

/**
 * Single editable row for a non-labor line item. Each column owns its
 * own tiny form so inline edits don't clobber unrelated columns — same
 * pattern used on the Labor Categories tab.
 */
function LineItemRow({
  li,
  pursuitId,
  currency,
}: {
  li: PricingLineItem;
  pursuitId: string;
  currency: string;
}) {
  const amount = lineItemAmount(li);
  return (
    <tr className="border-t border-[color:var(--color-border)]">
      <td className="px-4 py-2">
        <InlineTextForm
          name="clinNumber"
          value={li.clinNumber ?? ''}
          pursuitId={pursuitId}
          lineItemId={li.id}
          className="w-20 font-mono text-xs"
          placeholder="—"
        />
      </td>
      <td className="px-4 py-2">
        <InlineTextForm
          name="title"
          value={li.title}
          pursuitId={pursuitId}
          lineItemId={li.id}
          className="w-full text-sm font-medium"
        />
      </td>
      <td className="px-4 py-2">
        <form action={updateLineItemAction}>
          <input type="hidden" name="pursuitId" value={pursuitId} />
          <input type="hidden" name="lineItemId" value={li.id} />
          <select
            name="category"
            defaultValue={li.category}
            onChange={(e) => e.currentTarget.form?.requestSubmit()}
            className="rounded-full bg-[color:var(--color-muted)]/60 px-2 py-0.5 text-[11px] font-medium text-[color:var(--color-muted-foreground)]"
          >
            {LINE_ITEM_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {CATEGORY_LABEL[c]}
              </option>
            ))}
          </select>
        </form>
      </td>
      <td className="px-4 py-2 text-right">
        <InlineTextForm
          name="quantity"
          value={li.quantity ?? ''}
          pursuitId={pursuitId}
          lineItemId={li.id}
          type="number"
          step="0.01"
          className="w-16 text-right text-xs"
          placeholder="—"
        />
      </td>
      <td className="px-4 py-2 text-right">
        <InlineTextForm
          name="unitPrice"
          value={li.unitPrice ?? ''}
          pursuitId={pursuitId}
          lineItemId={li.id}
          type="number"
          step="0.01"
          className="w-24 text-right text-xs"
          placeholder="—"
        />
      </td>
      <td className="px-4 py-2 text-right">
        <div className="flex items-center justify-end gap-1">
          <InlineTextForm
            name="amount"
            value={li.amount ?? ''}
            pursuitId={pursuitId}
            lineItemId={li.id}
            type="number"
            step="0.01"
            className="w-24 text-right text-sm font-semibold"
            placeholder={formatMoney(amount, currency) ?? '—'}
          />
        </div>
      </td>
      <td className="px-4 py-2">
        <form action={removeLineItemAction}>
          <input type="hidden" name="pursuitId" value={pursuitId} />
          <input type="hidden" name="lineItemId" value={li.id} />
          <button
            type="submit"
            className="text-xs text-[color:var(--color-muted-foreground)] hover:text-red-600"
            title="Remove"
          >
            ×
          </button>
        </form>
      </td>
    </tr>
  );
}

/**
 * One-column inline edit. Renders a text/number input inside its own
 * form so only this field is submitted; server action uses formData.has()
 * to preserve untouched columns.
 */
function InlineTextForm({
  name,
  value,
  pursuitId,
  lineItemId,
  type = 'text',
  step,
  className = '',
  placeholder,
}: {
  name: string;
  value: string | number;
  pursuitId: string;
  lineItemId: string;
  type?: 'text' | 'number';
  step?: string;
  className?: string;
  placeholder?: string;
}) {
  return (
    <form action={updateLineItemAction} className="inline-flex gap-1">
      <input type="hidden" name="pursuitId" value={pursuitId} />
      <input type="hidden" name="lineItemId" value={lineItemId} />
      <input
        name={name}
        type={type}
        step={step}
        defaultValue={value}
        placeholder={placeholder}
        className={`rounded-[var(--radius-sm)] border border-transparent bg-transparent px-2 py-1 hover:border-[color:var(--color-border)] ${className}`}
      />
      <button type="submit" className="text-[10px] underline text-[color:var(--color-muted-foreground)]">
        Save
      </button>
    </form>
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

function lineItemBreakdownHint(
  byCategory: Array<{ category: LineItemCategory; count: number; total: number }>,
): string {
  if (byCategory.length === 0) return 'No line items';
  return byCategory
    .map((b) => `${CATEGORY_LABEL[b.category]} ${b.count}`)
    .join(' · ');
}
