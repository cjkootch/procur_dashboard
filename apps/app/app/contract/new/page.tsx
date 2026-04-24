import Link from 'next/link';
import { createContractAction } from '../actions';

export const dynamic = 'force-dynamic';

export default function NewContractPage() {
  return (
    <div className="mx-auto max-w-3xl px-8 py-10">
      <nav className="mb-6 text-sm text-[color:var(--color-muted-foreground)]">
        <Link href="/contract" className="hover:underline">
          Contract
        </Link>
        <span> / </span>
        <span className="text-[color:var(--color-foreground)]">New</span>
      </nav>
      <h1 className="mb-2 text-2xl font-semibold tracking-tight">New contract</h1>
      <p className="mb-6 text-sm text-[color:var(--color-muted-foreground)]">
        Use this for awards that don&rsquo;t live in a Procur pursuit — legacy work, subcontracts,
        or imported deals. For won pursuits, the Capture page offers a one-click create.
      </p>

      <form
        action={createContractAction}
        className="grid gap-4 rounded-[var(--radius-lg)] border border-[color:var(--color-border)] p-5 md:grid-cols-2"
      >
        <label className="md:col-span-2">
          <span className="text-xs text-[color:var(--color-muted-foreground)]">Award title</span>
          <input
            name="awardTitle"
            required
            className="mt-1 w-full rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1.5 text-sm"
          />
        </label>

        <label>
          <span className="text-xs text-[color:var(--color-muted-foreground)]">Tier</span>
          <select
            name="tier"
            defaultValue="prime"
            className="mt-1 w-full rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1.5 text-sm"
          >
            <option value="prime">Prime</option>
            <option value="subcontract">Subcontract</option>
            <option value="task_order">Task order</option>
          </select>
        </label>

        <label>
          <span className="text-xs text-[color:var(--color-muted-foreground)]">Contract number</span>
          <input
            name="contractNumber"
            className="mt-1 w-full rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1.5 text-sm"
          />
        </label>

        <label>
          <span className="text-xs text-[color:var(--color-muted-foreground)]">
            Awarding agency
          </span>
          <input
            name="awardingAgency"
            className="mt-1 w-full rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1.5 text-sm"
          />
        </label>

        <label>
          <span className="text-xs text-[color:var(--color-muted-foreground)]">
            Prime contractor (if sub)
          </span>
          <input
            name="primeContractor"
            className="mt-1 w-full rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1.5 text-sm"
          />
        </label>

        <label>
          <span className="text-xs text-[color:var(--color-muted-foreground)]">Award date</span>
          <input
            name="awardDate"
            type="date"
            className="mt-1 w-full rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1.5 text-sm"
          />
        </label>

        <label>
          <span className="text-xs text-[color:var(--color-muted-foreground)]">Start date</span>
          <input
            name="startDate"
            type="date"
            className="mt-1 w-full rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1.5 text-sm"
          />
        </label>

        <label>
          <span className="text-xs text-[color:var(--color-muted-foreground)]">End date</span>
          <input
            name="endDate"
            type="date"
            className="mt-1 w-full rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1.5 text-sm"
          />
        </label>

        <label>
          <span className="text-xs text-[color:var(--color-muted-foreground)]">Total value</span>
          <input
            name="totalValue"
            type="number"
            step="0.01"
            className="mt-1 w-full rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1.5 text-sm"
          />
        </label>

        <label>
          <span className="text-xs text-[color:var(--color-muted-foreground)]">Currency</span>
          <input
            name="currency"
            defaultValue="USD"
            maxLength={3}
            className="mt-1 w-full rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1.5 text-sm"
          />
        </label>

        <label>
          <span className="text-xs text-[color:var(--color-muted-foreground)]">FX to USD</span>
          <input
            name="fxRateToUsd"
            type="number"
            step="0.0001"
            placeholder="1.0"
            className="mt-1 w-full rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1.5 text-sm"
          />
        </label>

        <label className="md:col-span-2">
          <span className="text-xs text-[color:var(--color-muted-foreground)]">Notes</span>
          <textarea
            name="notes"
            rows={3}
            className="mt-1 w-full rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1.5 text-sm"
          />
        </label>

        <div className="md:col-span-2 flex items-center gap-3">
          <button
            type="submit"
            className="rounded-[var(--radius-md)] bg-[color:var(--color-foreground)] px-4 py-2 text-sm font-medium text-[color:var(--color-background)]"
          >
            Create contract
          </button>
          <Link
            href="/contract"
            className="text-sm text-[color:var(--color-muted-foreground)] hover:underline"
          >
            Cancel
          </Link>
        </div>
      </form>
    </div>
  );
}
