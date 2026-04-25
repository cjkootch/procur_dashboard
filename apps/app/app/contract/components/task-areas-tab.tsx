import type { ContractTaskArea } from '@procur/db';
import {
  addTaskAreaAction,
  removeTaskAreaAction,
  updateTaskAreaAction,
} from '../actions';

/**
 * Task Areas tab — SOW areas / domains. Each row is a named scope of
 * work with description, scope summary, period of performance, and
 * notes. Used by capture / proposal teams to map work breakdown onto
 * teaming partners and CLINs.
 */
export function TaskAreasTab({
  contractId,
  taskAreas,
}: {
  contractId: string;
  taskAreas: ContractTaskArea[];
}) {
  return (
    <div className="space-y-4">
      <section className="rounded-[var(--radius-md)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] p-4">
        <h2 className="mb-1 text-sm font-semibold">Add task area</h2>
        <p className="mb-3 text-xs text-[color:var(--color-muted-foreground)]">
          One row per SOW area / domain (e.g. "Software Engineering",
          "Cybersecurity Operations", "Logistics Support").
        </p>
        <form
          action={addTaskAreaAction}
          className="grid gap-2 sm:grid-cols-[1fr_2fr_0.7fr_0.7fr_auto]"
        >
          <input type="hidden" name="contractId" value={contractId} />
          <input
            name="name"
            placeholder="Task area name"
            required
            className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1.5 text-sm"
          />
          <input
            name="description"
            placeholder="Short description"
            className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1.5 text-sm"
          />
          <input
            name="periodStart"
            type="date"
            placeholder="Start"
            className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1.5 text-sm"
          />
          <input
            name="periodEnd"
            type="date"
            placeholder="End"
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

      {taskAreas.length === 0 ? (
        <section className="rounded-[var(--radius-md)] border border-dashed border-[color:var(--color-border)] p-8 text-center text-sm text-[color:var(--color-muted-foreground)]">
          No task areas yet.
        </section>
      ) : (
        <div className="space-y-2">
          {taskAreas.map((t) => (
            <TaskAreaCard key={t.id} ta={t} />
          ))}
        </div>
      )}
    </div>
  );
}

function TaskAreaCard({ ta }: { ta: ContractTaskArea }) {
  return (
    <details className="rounded-[var(--radius-md)] border border-[color:var(--color-border)] bg-[color:var(--color-background)]">
      <summary className="flex cursor-pointer flex-wrap items-center justify-between gap-3 px-4 py-2.5 text-sm">
        <div className="flex flex-wrap items-center gap-2 min-w-0">
          <span className="text-sm font-semibold">{ta.name}</span>
          {ta.description && (
            <span className="truncate text-[12px] text-[color:var(--color-muted-foreground)]">
              · {ta.description}
            </span>
          )}
        </div>
        {(ta.periodStart || ta.periodEnd) && (
          <span className="shrink-0 text-[11px] text-[color:var(--color-muted-foreground)]">
            {ta.periodStart ?? '—'} → {ta.periodEnd ?? '—'}
          </span>
        )}
      </summary>

      <div className="border-t border-[color:var(--color-border)] p-4">
        <form action={updateTaskAreaAction} className="grid gap-3 sm:grid-cols-2">
          <input type="hidden" name="taskAreaId" value={ta.id} />

          <Field label="Name">
            <input
              name="name"
              defaultValue={ta.name}
              className="w-full rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1 text-sm"
            />
          </Field>
          <Field label="Description">
            <input
              name="description"
              defaultValue={ta.description ?? ''}
              className="w-full rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1 text-sm"
            />
          </Field>

          <Field label="Period start">
            <input
              name="periodStart"
              type="date"
              defaultValue={ta.periodStart ?? ''}
              className="w-full rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1 text-sm"
            />
          </Field>
          <Field label="Period end">
            <input
              name="periodEnd"
              type="date"
              defaultValue={ta.periodEnd ?? ''}
              className="w-full rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1 text-sm"
            />
          </Field>

          <Field label="Scope summary" full>
            <textarea
              name="scope"
              rows={3}
              defaultValue={ta.scope ?? ''}
              placeholder="One paragraph describing this task area's scope of work."
              className="w-full rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1 text-sm"
            />
          </Field>

          <Field label="Notes" full>
            <textarea
              name="notes"
              rows={2}
              defaultValue={ta.notes ?? ''}
              className="w-full rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1 text-sm"
            />
          </Field>

          <div className="sm:col-span-2">
            <button
              type="submit"
              className="rounded-[var(--radius-sm)] bg-[color:var(--color-foreground)] px-3 py-1.5 text-xs font-medium text-[color:var(--color-background)]"
            >
              Save changes
            </button>
          </div>
        </form>

        <form action={removeTaskAreaAction} className="mt-3 text-right">
          <input type="hidden" name="taskAreaId" value={ta.id} />
          <button
            type="submit"
            className="text-[10px] text-[color:var(--color-muted-foreground)] hover:text-red-600"
          >
            Remove task area
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
    <label className={`block ${full ? 'sm:col-span-2' : ''}`}>
      <span className="text-[10px] font-semibold uppercase tracking-wider text-[color:var(--color-muted-foreground)]">
        {label}
      </span>
      <div className="mt-1">{children}</div>
    </label>
  );
}
