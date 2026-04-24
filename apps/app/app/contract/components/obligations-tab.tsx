import type { Contract } from '@procur/db';
import {
  addObligationAction,
  removeObligationAction,
  updateObligationStatusAction,
} from '../actions';

const STATUS_LABEL: Record<string, string> = {
  pending: 'Pending',
  in_progress: 'In progress',
  completed: 'Completed',
  overdue: 'Overdue',
};

const STATUS_STYLES: Record<string, string> = {
  pending: 'bg-[color:var(--color-muted)]/60',
  in_progress: 'bg-amber-500/15 text-amber-700',
  completed: 'bg-emerald-500/15 text-emerald-700',
  overdue: 'bg-red-500/15 text-red-700',
};

/**
 * Obligations tab — the table + add form, lifted from the old monolith
 * without behavioral changes. Client-side submits on status-select change
 * preserved via onChange -> requestSubmit, as before.
 */
export function ObligationsTab({ contract }: { contract: Contract }) {
  const obligations = contract.obligations ?? [];

  return (
    <div className="rounded-[var(--radius-md)] border border-[color:var(--color-border)] bg-[color:var(--color-background)]">
      <header className="flex items-center justify-between border-b border-[color:var(--color-border)] px-5 py-3">
        <h2 className="text-sm font-semibold">
          Obligations &amp; deliverables ({obligations.length})
        </h2>
      </header>

      {obligations.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-[color:var(--color-border)] text-[11px] uppercase tracking-wider text-[color:var(--color-muted-foreground)]">
              <tr>
                <th className="px-4 py-2 font-medium">Description</th>
                <th className="px-4 py-2 font-medium">Due</th>
                <th className="px-4 py-2 font-medium">Frequency</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {obligations.map((o) => (
                <tr key={o.id} className="border-t border-[color:var(--color-border)]">
                  <td className="px-4 py-2">{o.description}</td>
                  <td className="px-4 py-2 text-xs text-[color:var(--color-muted-foreground)]">
                    {o.dueDate ?? '—'}
                  </td>
                  <td className="px-4 py-2 text-xs capitalize text-[color:var(--color-muted-foreground)]">
                    {o.frequency ?? 'once'}
                  </td>
                  <td className="px-4 py-2">
                    <form action={updateObligationStatusAction}>
                      <input type="hidden" name="contractId" value={contract.id} />
                      <input type="hidden" name="obligationId" value={o.id} />
                      <select
                        name="status"
                        defaultValue={o.status}
                        onChange={(e) => e.currentTarget.form?.requestSubmit()}
                        className={`rounded-full px-2 py-0.5 text-xs ${STATUS_STYLES[o.status] ?? ''}`}
                      >
                        {Object.entries(STATUS_LABEL).map(([k, v]) => (
                          <option key={k} value={k}>
                            {v}
                          </option>
                        ))}
                      </select>
                    </form>
                  </td>
                  <td className="px-4 py-2 text-right">
                    <form action={removeObligationAction}>
                      <input type="hidden" name="contractId" value={contract.id} />
                      <input type="hidden" name="obligationId" value={o.id} />
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
              ))}
            </tbody>
          </table>
        </div>
      )}

      <form
        action={addObligationAction}
        className="flex flex-wrap items-end gap-3 border-t border-[color:var(--color-border)] p-4"
      >
        <input type="hidden" name="contractId" value={contract.id} />
        <label className="flex flex-1 min-w-[200px] flex-col gap-1 text-sm">
          <span className="text-[11px] uppercase tracking-wider text-[color:var(--color-muted-foreground)]">
            Add obligation
          </span>
          <input
            name="description"
            required
            placeholder="e.g. Monthly status report · CDRL A001"
            className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] px-2 py-1 text-sm"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-[11px] uppercase tracking-wider text-[color:var(--color-muted-foreground)]">
            Due date
          </span>
          <input
            name="dueDate"
            type="date"
            className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] px-2 py-1 text-sm"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-[11px] uppercase tracking-wider text-[color:var(--color-muted-foreground)]">
            Frequency
          </span>
          <select
            name="frequency"
            defaultValue="once"
            className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1 text-sm"
          >
            <option value="once">Once</option>
            <option value="monthly">Monthly</option>
            <option value="quarterly">Quarterly</option>
            <option value="annually">Annually</option>
          </select>
        </label>
        <button
          type="submit"
          className="rounded-[var(--radius-md)] bg-[color:var(--color-foreground)] px-3 py-1.5 text-sm font-medium text-[color:var(--color-background)]"
        >
          + Add
        </button>
      </form>
    </div>
  );
}
