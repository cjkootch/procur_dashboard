import type { Contract } from '@procur/db';
import { deleteContractAction, updateContractAction } from '../actions';

/**
 * Overview tab — the contract metadata form (tier, numbers, agency, dates,
 * value, notes). Kept as a single save form, matching our Pricer Overview
 * tab pattern.
 *
 * Delete is a separate small form at the bottom.
 */
export function OverviewTab({ contract }: { contract: Contract }) {
  return (
    <div className="space-y-4">
      <form
        action={updateContractAction}
        className="grid gap-4 rounded-[var(--radius-md)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] p-5 md:grid-cols-2"
      >
        <input type="hidden" name="id" value={contract.id} />

        <label className="md:col-span-2">
          <Label>Award title</Label>
          <input
            name="awardTitle"
            defaultValue={contract.awardTitle}
            required
            className={INPUT_CLS}
          />
        </label>

        <label>
          <Label>Tier</Label>
          <select name="tier" defaultValue={contract.tier} className={INPUT_CLS}>
            <option value="prime">Prime</option>
            <option value="subcontract">Subcontract</option>
            <option value="task_order">Task order</option>
          </select>
        </label>
        <label>
          <Label>Status</Label>
          <select name="status" defaultValue={contract.status} className={INPUT_CLS}>
            <option value="active">Active</option>
            <option value="completed">Completed</option>
            <option value="terminated">Terminated</option>
          </select>
        </label>

        <label>
          <Label>Contract number</Label>
          <input
            name="contractNumber"
            defaultValue={contract.contractNumber ?? ''}
            className={INPUT_CLS}
          />
        </label>
        <label>
          <Label>Parent contract #</Label>
          <input
            name="parentContractNumber"
            defaultValue={contract.parentContractNumber ?? ''}
            className={INPUT_CLS}
          />
        </label>
        <label>
          <Label>Task order #</Label>
          <input
            name="taskOrderNumber"
            defaultValue={contract.taskOrderNumber ?? ''}
            className={INPUT_CLS}
          />
        </label>
        <label>
          <Label>Subcontract #</Label>
          <input
            name="subcontractNumber"
            defaultValue={contract.subcontractNumber ?? ''}
            className={INPUT_CLS}
          />
        </label>

        <label>
          <Label>Awarding agency</Label>
          <input
            name="awardingAgency"
            defaultValue={contract.awardingAgency ?? ''}
            className={INPUT_CLS}
          />
        </label>
        <label>
          <Label>Prime contractor</Label>
          <input
            name="primeContractor"
            defaultValue={contract.primeContractor ?? ''}
            className={INPUT_CLS}
          />
        </label>

        <label>
          <Label>Award date</Label>
          <input
            name="awardDate"
            type="date"
            defaultValue={contract.awardDate ?? ''}
            className={INPUT_CLS}
          />
        </label>
        <label>
          <Label>Start date</Label>
          <input
            name="startDate"
            type="date"
            defaultValue={contract.startDate ?? ''}
            className={INPUT_CLS}
          />
        </label>
        <label>
          <Label>End date</Label>
          <input
            name="endDate"
            type="date"
            defaultValue={contract.endDate ?? ''}
            className={INPUT_CLS}
          />
        </label>

        <label>
          <Label>Total value</Label>
          <input
            name="totalValue"
            type="number"
            step="0.01"
            defaultValue={contract.totalValue ?? ''}
            className={INPUT_CLS}
          />
        </label>
        <label>
          <Label>Currency</Label>
          <input
            name="currency"
            defaultValue={contract.currency ?? 'USD'}
            maxLength={3}
            className={`${INPUT_CLS} uppercase`}
          />
        </label>
        <label>
          <Label>FX to USD</Label>
          <input
            name="fxRateToUsd"
            type="number"
            step="0.0001"
            placeholder="1.0"
            className={INPUT_CLS}
          />
        </label>

        <label className="md:col-span-2">
          <Label>Notes</Label>
          <textarea
            name="notes"
            rows={3}
            defaultValue={contract.notes ?? ''}
            className={INPUT_CLS}
          />
        </label>

        <div className="md:col-span-2 flex justify-end">
          <button
            type="submit"
            className="rounded-[var(--radius-md)] bg-[color:var(--color-foreground)] px-4 py-2 text-sm font-medium text-[color:var(--color-background)]"
          >
            Save Overview
          </button>
        </div>
      </form>

      <section className="flex items-center justify-between rounded-[var(--radius-md)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] p-4">
        <div>
          <p className="text-sm font-medium">Danger zone</p>
          <p className="mt-0.5 text-xs text-[color:var(--color-muted-foreground)]">
            Deleting a contract removes obligations and unlinks past performance.
            This cannot be undone.
          </p>
        </div>
        <form action={deleteContractAction}>
          <input type="hidden" name="id" value={contract.id} />
          <button
            type="submit"
            className="rounded-[var(--radius-sm)] border border-red-500/40 px-3 py-1.5 text-xs font-medium text-red-600 hover:bg-red-500/10"
          >
            Delete contract
          </button>
        </form>
      </section>
    </div>
  );
}

const INPUT_CLS =
  'mt-1 w-full rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1.5 text-sm';

function Label({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-[11px] uppercase tracking-wider text-[color:var(--color-muted-foreground)]">
      {children}
    </span>
  );
}
