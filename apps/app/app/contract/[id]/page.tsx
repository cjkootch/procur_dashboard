import Link from 'next/link';
import { notFound } from 'next/navigation';
import { and, eq } from 'drizzle-orm';
import { db, pastPerformance } from '@procur/db';
import { requireCompany } from '@procur/auth';
import { getContractById } from '../../../lib/contract-queries';
import { formatDate, formatMoney } from '../../../lib/format';
import {
  addObligationAction,
  deleteContractAction,
  removeObligationAction,
  updateContractAction,
  updateObligationStatusAction,
} from '../actions';
import { generateFromContractAction } from '../../past-performance/actions';

export const dynamic = 'force-dynamic';

const STATUS_LABEL: Record<string, string> = {
  pending: 'Pending',
  in_progress: 'In progress',
  completed: 'Completed',
  overdue: 'Overdue',
};

const STATUS_STYLES: Record<string, string> = {
  pending: 'bg-[color:var(--color-muted)]/60',
  in_progress: 'bg-amber-100 text-amber-900',
  completed: 'bg-emerald-100 text-emerald-900',
  overdue: 'bg-red-100 text-red-900',
};

export default async function ContractDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { company } = await requireCompany();
  const contract = await getContractById(company.id, id);
  if (!contract) notFound();

  const obligations = contract.obligations ?? [];
  const totalValue = formatMoney(contract.totalValue, contract.currency);
  const totalUsd = formatMoney(contract.totalValueUsd, 'USD');

  const existingPP = await db.query.pastPerformance.findFirst({
    where: and(
      eq(pastPerformance.companyId, company.id),
      eq(pastPerformance.projectName, contract.awardTitle),
    ),
    columns: { id: true },
  });

  return (
    <div className="mx-auto max-w-5xl px-8 py-10">
      <nav className="mb-6 text-sm text-[color:var(--color-muted-foreground)]">
        <Link href="/contract" className="hover:underline">
          Contract
        </Link>
        <span> / </span>
        <span className="text-[color:var(--color-foreground)]">{contract.awardTitle}</span>
      </nav>

      <header className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{contract.awardTitle}</h1>
          <p className="mt-1 text-sm text-[color:var(--color-muted-foreground)]">
            {contract.awardingAgency ?? '—'}
            {contract.contractNumber && <> · {contract.contractNumber}</>}
            {contract.primeContractor && <> · under {contract.primeContractor}</>}
          </p>
        </div>
        {contract.pursuitId && (
          <Link
            href={`/capture/pursuits/${contract.pursuitId}`}
            className="text-sm underline"
          >
            Pursuit details →
          </Link>
        )}
      </header>

      <section className="mb-6 flex flex-wrap items-center gap-3 rounded-[var(--radius-lg)] border border-dashed border-[color:var(--color-border)] p-4">
        <div className="flex-1 min-w-[260px]">
          <p className="text-sm font-medium">Past performance</p>
          <p className="mt-1 text-xs text-[color:var(--color-muted-foreground)]">
            Turn this contract into a reusable reference for future proposals. Carries over
            customer, period, value, and any completed obligations as accomplishments.
          </p>
        </div>
        {existingPP ? (
          <Link
            href={`/past-performance/${existingPP.id}`}
            className="rounded-[var(--radius-md)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-3 py-1.5 text-xs font-medium"
          >
            View entry →
          </Link>
        ) : (
          <form action={generateFromContractAction}>
            <input type="hidden" name="contractId" value={contract.id} />
            <button
              type="submit"
              className="rounded-[var(--radius-md)] bg-[color:var(--color-foreground)] px-3 py-1.5 text-xs font-medium text-[color:var(--color-background)]"
            >
              Generate past performance
            </button>
          </form>
        )}
      </section>

      <section className="mb-8 grid gap-4 rounded-[var(--radius-lg)] border border-[color:var(--color-border)] p-6 md:grid-cols-5">
        <Fact
          label="Total value"
          value={totalValue ?? '—'}
          sub={totalUsd && contract.currency !== 'USD' ? `≈ ${totalUsd}` : undefined}
        />
        <Fact label="Status" value={contract.status} />
        <Fact
          label="Period"
          value={
            contract.startDate && contract.endDate
              ? `${formatDate(new Date(contract.startDate))} → ${formatDate(new Date(contract.endDate))}`
              : contract.startDate
                ? `From ${formatDate(new Date(contract.startDate))}`
                : '—'
          }
        />
        <Fact
          label="Awarded"
          value={contract.awardDate ? formatDate(new Date(contract.awardDate)) : '—'}
        />
        <Fact
          label="Obligations"
          value={`${obligations.filter((o) => o.status !== 'completed').length}/${obligations.length} open`}
        />
      </section>

      <section className="mb-10">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
          Obligations &amp; deliverables ({obligations.length})
        </h2>

        {obligations.length > 0 && (
          <div className="mb-4 overflow-hidden rounded-[var(--radius-lg)] border border-[color:var(--color-border)]">
            <table className="w-full text-left text-sm">
              <thead className="bg-[color:var(--color-muted)]/40 text-xs uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
                <tr>
                  <th className="px-3 py-2">Description</th>
                  <th className="px-3 py-2">Due</th>
                  <th className="px-3 py-2">Frequency</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {obligations.map((o) => (
                  <tr key={o.id} className="border-t border-[color:var(--color-border)]">
                    <td className="px-3 py-2">{o.description}</td>
                    <td className="px-3 py-2">{o.dueDate ?? '—'}</td>
                    <td className="px-3 py-2 capitalize">{o.frequency ?? 'once'}</td>
                    <td className="px-3 py-2">
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
                    <td className="px-3 py-2 text-right">
                      <form action={removeObligationAction}>
                        <input type="hidden" name="contractId" value={contract.id} />
                        <input type="hidden" name="obligationId" value={o.id} />
                        <button
                          type="submit"
                          className="text-xs text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-brand)]"
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
          className="flex flex-wrap items-end gap-3 rounded-[var(--radius-lg)] border border-[color:var(--color-border)] p-4"
        >
          <input type="hidden" name="contractId" value={contract.id} />
          <label className="flex flex-1 min-w-[200px] flex-col gap-1 text-sm">
            <span className="text-xs text-[color:var(--color-muted-foreground)]">
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
            <span className="text-xs text-[color:var(--color-muted-foreground)]">Due date</span>
            <input
              name="dueDate"
              type="date"
              className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] px-2 py-1 text-sm"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-xs text-[color:var(--color-muted-foreground)]">Frequency</span>
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
            Add
          </button>
        </form>
      </section>

      <section className="mb-10">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
          Contract details
        </h2>
        <form
          action={updateContractAction}
          className="grid gap-4 rounded-[var(--radius-lg)] border border-[color:var(--color-border)] p-5 md:grid-cols-2"
        >
          <input type="hidden" name="id" value={contract.id} />
          <label className="md:col-span-2">
            <span className="text-xs text-[color:var(--color-muted-foreground)]">
              Award title
            </span>
            <input
              name="awardTitle"
              defaultValue={contract.awardTitle}
              required
              className="mt-1 w-full rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1.5 text-sm"
            />
          </label>
          <label>
            <span className="text-xs text-[color:var(--color-muted-foreground)]">Tier</span>
            <select
              name="tier"
              defaultValue={contract.tier}
              className="mt-1 w-full rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1.5 text-sm"
            >
              <option value="prime">Prime</option>
              <option value="subcontract">Subcontract</option>
              <option value="task_order">Task order</option>
            </select>
          </label>
          <label>
            <span className="text-xs text-[color:var(--color-muted-foreground)]">Status</span>
            <select
              name="status"
              defaultValue={contract.status}
              className="mt-1 w-full rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1.5 text-sm"
            >
              <option value="active">Active</option>
              <option value="completed">Completed</option>
              <option value="terminated">Terminated</option>
            </select>
          </label>
          <label>
            <span className="text-xs text-[color:var(--color-muted-foreground)]">
              Contract number
            </span>
            <input
              name="contractNumber"
              defaultValue={contract.contractNumber ?? ''}
              className="mt-1 w-full rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1.5 text-sm"
            />
          </label>
          <label>
            <span className="text-xs text-[color:var(--color-muted-foreground)]">
              Parent contract #
            </span>
            <input
              name="parentContractNumber"
              defaultValue={contract.parentContractNumber ?? ''}
              className="mt-1 w-full rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1.5 text-sm"
            />
          </label>
          <label>
            <span className="text-xs text-[color:var(--color-muted-foreground)]">
              Task order #
            </span>
            <input
              name="taskOrderNumber"
              defaultValue={contract.taskOrderNumber ?? ''}
              className="mt-1 w-full rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1.5 text-sm"
            />
          </label>
          <label>
            <span className="text-xs text-[color:var(--color-muted-foreground)]">
              Subcontract #
            </span>
            <input
              name="subcontractNumber"
              defaultValue={contract.subcontractNumber ?? ''}
              className="mt-1 w-full rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1.5 text-sm"
            />
          </label>
          <label>
            <span className="text-xs text-[color:var(--color-muted-foreground)]">
              Awarding agency
            </span>
            <input
              name="awardingAgency"
              defaultValue={contract.awardingAgency ?? ''}
              className="mt-1 w-full rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1.5 text-sm"
            />
          </label>
          <label>
            <span className="text-xs text-[color:var(--color-muted-foreground)]">
              Prime contractor
            </span>
            <input
              name="primeContractor"
              defaultValue={contract.primeContractor ?? ''}
              className="mt-1 w-full rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1.5 text-sm"
            />
          </label>
          <label>
            <span className="text-xs text-[color:var(--color-muted-foreground)]">Award date</span>
            <input
              name="awardDate"
              type="date"
              defaultValue={contract.awardDate ?? ''}
              className="mt-1 w-full rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1.5 text-sm"
            />
          </label>
          <label>
            <span className="text-xs text-[color:var(--color-muted-foreground)]">Start date</span>
            <input
              name="startDate"
              type="date"
              defaultValue={contract.startDate ?? ''}
              className="mt-1 w-full rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1.5 text-sm"
            />
          </label>
          <label>
            <span className="text-xs text-[color:var(--color-muted-foreground)]">End date</span>
            <input
              name="endDate"
              type="date"
              defaultValue={contract.endDate ?? ''}
              className="mt-1 w-full rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1.5 text-sm"
            />
          </label>
          <label>
            <span className="text-xs text-[color:var(--color-muted-foreground)]">
              Total value
            </span>
            <input
              name="totalValue"
              type="number"
              step="0.01"
              defaultValue={contract.totalValue ?? ''}
              className="mt-1 w-full rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1.5 text-sm"
            />
          </label>
          <label>
            <span className="text-xs text-[color:var(--color-muted-foreground)]">Currency</span>
            <input
              name="currency"
              defaultValue={contract.currency ?? 'USD'}
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
              defaultValue={contract.notes ?? ''}
              className="mt-1 w-full rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1.5 text-sm"
            />
          </label>
          <div className="md:col-span-2 flex items-center justify-between">
            <button
              type="submit"
              className="rounded-[var(--radius-md)] bg-[color:var(--color-foreground)] px-4 py-2 text-sm font-medium text-[color:var(--color-background)]"
            >
              Save
            </button>
          </div>
        </form>
      </section>

      <section>
        <form action={deleteContractAction}>
          <input type="hidden" name="id" value={contract.id} />
          <button
            type="submit"
            className="text-xs text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-brand)]"
          >
            Delete contract
          </button>
        </form>
      </section>
    </div>
  );
}

function Fact({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
        {label}
      </p>
      <p className="mt-1 text-base font-semibold capitalize">{value}</p>
      {sub && <p className="text-xs text-[color:var(--color-muted-foreground)]">{sub}</p>}
    </div>
  );
}
