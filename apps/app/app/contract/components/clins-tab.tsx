import { CLIN_TYPES, type ClinType, type ContractClin } from '@procur/db';
import { CLIN_TYPE_LABEL, type ClinsSummary } from '../../../lib/contract-extras-queries';
import { chipClass, type ChipTone } from '../../../lib/chips';
import { addClinAction, removeClinAction, updateClinAction } from '../actions';

const CLIN_TYPE_TONE: Record<ClinType, ChipTone> = {
  fixed_price: 'success',
  cost_plus: 'warning',
  time_and_materials: 'info',
  labor_hour: 'info',
  other: 'neutral',
};

/**
 * CLINs tab — Contract Line Item Numbers. Each row represents one line
 * item with quantity, unit, unit price, total amount, and period of
 * performance. The total amount is auto-derived from quantity × unit
 * price if not explicitly stored, mirroring how RFP price schedules
 * usually arrive.
 */
export function ClinsTab({
  contractId,
  clins,
  summary,
  currency,
}: {
  contractId: string;
  clins: ContractClin[];
  summary: ClinsSummary;
  currency: string | null;
}) {
  const fmt = (n: number) =>
    new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: currency || 'USD',
      maximumFractionDigits: 0,
    }).format(n);

  return (
    <div className="space-y-4">
      <section className="grid gap-3 rounded-[var(--radius-md)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] p-4 sm:grid-cols-3">
        <Stat label="CLINs" value={summary.total.toString()} />
        <Stat label="Total amount" value={fmt(summary.totalAmount)} />
        <Stat label="Currency" value={currency || 'USD'} />
      </section>

      <section className="rounded-[var(--radius-md)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] p-4">
        <h2 className="mb-1 text-sm font-semibold">Add CLIN</h2>
        <p className="mb-3 text-xs text-[color:var(--color-muted-foreground)]">
          One row per Contract Line Item Number. Leave amount blank to
          derive it from quantity × unit price.
        </p>
        <form
          action={addClinAction}
          className="grid gap-2 sm:grid-cols-[0.6fr_2fr_1fr_auto]"
        >
          <input type="hidden" name="contractId" value={contractId} />
          <input
            name="clinNumber"
            placeholder="CLIN #"
            required
            className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1.5 text-sm"
          />
          <input
            name="title"
            placeholder="Title / description"
            required
            className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1.5 text-sm"
          />
          <select
            name="clinType"
            defaultValue="fixed_price"
            className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1.5 text-sm"
          >
            {CLIN_TYPES.map((t) => (
              <option key={t} value={t}>
                {CLIN_TYPE_LABEL[t]}
              </option>
            ))}
          </select>
          <button
            type="submit"
            className="rounded-[var(--radius-md)] bg-[color:var(--color-foreground)] px-3 py-1.5 text-sm font-medium text-[color:var(--color-background)]"
          >
            + Add
          </button>
        </form>
      </section>

      {clins.length === 0 ? (
        <section className="rounded-[var(--radius-md)] border border-dashed border-[color:var(--color-border)] p-8 text-center text-sm text-[color:var(--color-muted-foreground)]">
          No CLINs yet.
        </section>
      ) : (
        <div className="space-y-2">
          {clins.map((c) => (
            <ClinCard key={c.id} clin={c} fmt={fmt} />
          ))}
        </div>
      )}
    </div>
  );
}

function ClinCard({ clin, fmt }: { clin: ContractClin; fmt: (n: number) => string }) {
  const qty = clin.quantity == null ? null : Number(clin.quantity);
  const unitPrice = clin.unitPrice == null ? null : Number(clin.unitPrice);
  const explicitAmount = clin.amount == null ? null : Number(clin.amount);
  const computedAmount =
    explicitAmount ?? (qty != null && unitPrice != null ? qty * unitPrice : null);

  return (
    <details className="rounded-[var(--radius-md)] border border-[color:var(--color-border)] bg-[color:var(--color-background)]">
      <summary className="flex cursor-pointer flex-wrap items-center justify-between gap-3 px-4 py-2.5 text-sm">
        <div className="flex flex-wrap items-center gap-2 min-w-0">
          <span className="font-mono text-sm font-semibold">{clin.clinNumber}</span>
          <span
            className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${chipClass(CLIN_TYPE_TONE[clin.clinType])}`}
          >
            {CLIN_TYPE_LABEL[clin.clinType]}
          </span>
          <span className="truncate text-[13px]">{clin.title}</span>
        </div>
        <span className="shrink-0 font-mono text-xs">
          {computedAmount == null ? '—' : fmt(computedAmount)}
        </span>
      </summary>

      <div className="border-t border-[color:var(--color-border)] p-4">
        <form action={updateClinAction} className="grid gap-3 sm:grid-cols-3">
          <input type="hidden" name="clinId" value={clin.id} />

          <Field label="CLIN #">
            <input
              name="clinNumber"
              defaultValue={clin.clinNumber}
              className="w-full rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1 text-sm"
            />
          </Field>
          <Field label="Title">
            <input
              name="title"
              defaultValue={clin.title}
              className="w-full rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1 text-sm"
            />
          </Field>
          <Field label="Type">
            <select
              name="clinType"
              defaultValue={clin.clinType}
              className="w-full rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1 text-sm"
            >
              {CLIN_TYPES.map((t) => (
                <option key={t} value={t}>
                  {CLIN_TYPE_LABEL[t]}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Quantity">
            <input
              name="quantity"
              type="number"
              step="0.0001"
              defaultValue={qty ?? ''}
              className="w-full rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1 text-sm"
            />
          </Field>
          <Field label="Unit of measure">
            <input
              name="unitOfMeasure"
              defaultValue={clin.unitOfMeasure ?? ''}
              placeholder="e.g. hour, lot"
              className="w-full rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1 text-sm"
            />
          </Field>
          <Field label="Unit price">
            <input
              name="unitPrice"
              type="number"
              step="0.0001"
              defaultValue={unitPrice ?? ''}
              className="w-full rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1 text-sm"
            />
          </Field>

          <Field label="Amount (override)">
            <input
              name="amount"
              type="number"
              step="0.01"
              defaultValue={explicitAmount ?? ''}
              placeholder={
                computedAmount != null && explicitAmount == null
                  ? `auto: ${computedAmount.toFixed(2)}`
                  : undefined
              }
              className="w-full rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1 text-sm"
            />
          </Field>
          <Field label="Period start">
            <input
              name="periodStart"
              type="date"
              defaultValue={clin.periodStart ?? ''}
              className="w-full rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1 text-sm"
            />
          </Field>
          <Field label="Period end">
            <input
              name="periodEnd"
              type="date"
              defaultValue={clin.periodEnd ?? ''}
              className="w-full rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1 text-sm"
            />
          </Field>

          <Field label="Notes" full>
            <textarea
              name="notes"
              rows={2}
              defaultValue={clin.notes ?? ''}
              className="w-full rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1 text-sm"
            />
          </Field>

          <div className="sm:col-span-3">
            <button
              type="submit"
              className="rounded-[var(--radius-sm)] bg-[color:var(--color-foreground)] px-3 py-1.5 text-xs font-medium text-[color:var(--color-background)]"
            >
              Save changes
            </button>
          </div>
        </form>

        <form action={removeClinAction} className="mt-3 text-right">
          <input type="hidden" name="clinId" value={clin.id} />
          <button
            type="submit"
            className="text-[10px] text-[color:var(--color-muted-foreground)] hover:text-red-600"
          >
            Remove CLIN
          </button>
        </form>
      </div>
    </details>
  );
}

function Field({
  label,
  full,
  children,
}: {
  label: string;
  full?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className={`block ${full ? 'sm:col-span-3' : ''}`}>
      <span className="text-[10px] font-semibold uppercase tracking-wider text-[color:var(--color-muted-foreground)]">
        {label}
      </span>
      <div className="mt-1">{children}</div>
    </label>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[10px] font-semibold uppercase tracking-wider text-[color:var(--color-muted-foreground)]">
        {label}
      </p>
      <p className="mt-0.5 text-sm font-semibold text-[color:var(--color-foreground)]">{value}</p>
    </div>
  );
}
