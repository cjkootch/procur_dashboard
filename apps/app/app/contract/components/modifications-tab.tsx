import {
  MODIFICATION_ACTION_TYPES,
  type ContractModification,
  type ModificationActionType,
} from '@procur/db';
import {
  MODIFICATION_ACTION_LABEL,
  type ModificationsSummary,
} from '../../../lib/contract-extras-queries';
import { chipClass, type ChipTone } from '../../../lib/chips';
import {
  addModificationAction,
  removeModificationAction,
  updateModificationAction,
} from '../actions';

const ACTION_TONE: Record<ModificationActionType, ChipTone> = {
  admin: 'neutral',
  funding: 'success',
  scope: 'accent',
  period_of_performance: 'info',
  price: 'warning',
  novation: 'warning',
  termination: 'danger',
  other: 'neutral',
};

/**
 * Modifications tab — list of contract mods (amendments / change orders).
 * Each row is a collapsible card with an inline edit form so all the
 * fields stay tied to one server action submission, avoiding the form-
 * inside-table-row footgun.
 *
 * Funding-change roll-up at the top sums the signed deltas so a quick
 * glance answers "how much has this contract grown / shrunk over its life?"
 */
export function ModificationsTab({
  contractId,
  modifications,
  summary,
  currency,
}: {
  contractId: string;
  modifications: ContractModification[];
  summary: ModificationsSummary;
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
        <Stat label="Modifications" value={summary.total.toString()} />
        <Stat
          label="Net funding change"
          value={fmt(summary.totalFundingChange)}
          tone={
            summary.totalFundingChange > 0
              ? 'success'
              : summary.totalFundingChange < 0
                ? 'danger'
                : 'neutral'
          }
        />
        <Stat label="Currency" value={currency || 'USD'} />
      </section>

      {/* Add modification */}
      <section className="rounded-[var(--radius-md)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] p-4">
        <h2 className="mb-1 text-sm font-semibold">Add modification</h2>
        <p className="mb-3 text-xs text-[color:var(--color-muted-foreground)]">
          One row per amendment / change order. Funding change is signed —
          use a negative number for de-obligations.
        </p>
        <form
          action={addModificationAction}
          className="grid gap-2 sm:grid-cols-[0.6fr_0.7fr_1fr_0.7fr_2fr_auto]"
        >
          <input type="hidden" name="contractId" value={contractId} />
          <input
            name="modNumber"
            placeholder="Mod #"
            required
            className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1.5 text-sm"
          />
          <input
            name="actionDate"
            type="date"
            className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1.5 text-sm"
          />
          <select
            name="actionType"
            defaultValue="other"
            className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1.5 text-sm"
          >
            {MODIFICATION_ACTION_TYPES.map((t) => (
              <option key={t} value={t}>
                {MODIFICATION_ACTION_LABEL[t]}
              </option>
            ))}
          </select>
          <input
            name="fundingChange"
            type="number"
            step="0.01"
            placeholder="Funding Δ"
            className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1.5 text-sm"
          />
          <input
            name="description"
            placeholder="Description"
            className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1.5 text-sm"
          />
          <button
            type="submit"
            className="rounded-[var(--radius-md)] bg-[color:var(--color-foreground)] px-3 py-1.5 text-sm font-medium text-[color:var(--color-background)]"
          >
            + Add
          </button>
        </form>
      </section>

      {modifications.length === 0 ? (
        <section className="rounded-[var(--radius-md)] border border-dashed border-[color:var(--color-border)] p-8 text-center text-sm text-[color:var(--color-muted-foreground)]">
          No modifications recorded yet.
        </section>
      ) : (
        <div className="space-y-2">
          {modifications.map((m) => (
            <ModificationCard key={m.id} mod={m} fmt={fmt} />
          ))}
        </div>
      )}
    </div>
  );
}

function ModificationCard({
  mod,
  fmt,
}: {
  mod: ContractModification;
  fmt: (n: number) => string;
}) {
  const fc = mod.fundingChange == null ? null : Number(mod.fundingChange);
  const fundingClass =
    fc != null && fc > 0 ? 'text-emerald-700' : fc != null && fc < 0 ? 'text-red-700' : '';
  return (
    <details className="rounded-[var(--radius-md)] border border-[color:var(--color-border)] bg-[color:var(--color-background)]">
      <summary className="flex cursor-pointer flex-wrap items-center justify-between gap-3 px-4 py-2.5 text-sm">
        <div className="flex flex-wrap items-center gap-2 min-w-0">
          <span className="font-mono text-sm font-semibold">Mod {mod.modNumber}</span>
          <span
            className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${chipClass(ACTION_TONE[mod.actionType])}`}
          >
            {MODIFICATION_ACTION_LABEL[mod.actionType]}
          </span>
          {mod.actionDate && (
            <span className="text-[11px] text-[color:var(--color-muted-foreground)]">
              {mod.actionDate}
            </span>
          )}
          {mod.description && (
            <span className="truncate text-[12px] text-[color:var(--color-muted-foreground)]">
              · {mod.description}
            </span>
          )}
        </div>
        <span className={`shrink-0 font-mono text-xs ${fundingClass}`}>
          {fc == null ? '' : `${fc > 0 ? '+' : ''}${fmt(fc)}`}
        </span>
      </summary>

      <div className="border-t border-[color:var(--color-border)] p-4">
        <form action={updateModificationAction} className="grid gap-3 sm:grid-cols-3">
          <input type="hidden" name="modificationId" value={mod.id} />

          <Field label="Mod #">
            <input
              name="modNumber"
              defaultValue={mod.modNumber}
              className="w-full rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1 text-sm"
            />
          </Field>
          <Field label="Action date">
            <input
              name="actionDate"
              type="date"
              defaultValue={mod.actionDate ?? ''}
              className="w-full rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1 text-sm"
            />
          </Field>
          <Field label="Action type">
            <select
              name="actionType"
              defaultValue={mod.actionType}
              className="w-full rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1 text-sm"
            >
              {MODIFICATION_ACTION_TYPES.map((t) => (
                <option key={t} value={t}>
                  {MODIFICATION_ACTION_LABEL[t]}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Funding change">
            <input
              name="fundingChange"
              type="number"
              step="0.01"
              defaultValue={fc ?? ''}
              className="w-full rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1 text-sm"
            />
          </Field>
          <Field label="Source">
            <input
              name="source"
              defaultValue={mod.source ?? ''}
              placeholder="e.g. Document upload"
              className="w-full rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1 text-sm"
            />
          </Field>
          <Field label="Document URL">
            <input
              name="documentUrl"
              type="url"
              defaultValue={mod.documentUrl ?? ''}
              placeholder="https://…"
              className="w-full rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1 text-sm"
            />
          </Field>

          <Field label="Description" full>
            <textarea
              name="description"
              rows={2}
              defaultValue={mod.description ?? ''}
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

        <form action={removeModificationAction} className="mt-3 text-right">
          <input type="hidden" name="modificationId" value={mod.id} />
          <button
            type="submit"
            className="text-[10px] text-[color:var(--color-muted-foreground)] hover:text-red-600"
          >
            Remove modification
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

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: ChipTone;
}) {
  const valueClass =
    tone === 'danger'
      ? 'text-red-700'
      : tone === 'success'
        ? 'text-emerald-700'
        : tone === 'warning'
          ? 'text-amber-700'
          : 'text-[color:var(--color-foreground)]';
  return (
    <div>
      <p className="text-[10px] font-semibold uppercase tracking-wider text-[color:var(--color-muted-foreground)]">
        {label}
      </p>
      <p className={`mt-0.5 text-sm font-semibold ${valueClass}`}>{value}</p>
    </div>
  );
}
