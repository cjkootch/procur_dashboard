import Link from 'next/link';
import { requireCompany } from '@procur/auth';
import {
  listAwardableCaptures,
  listContracts,
  type ContractListRow,
} from '../../lib/contract-queries';
import { formatDate, formatMoney } from '../../lib/format';
import { createContractFromPursuitAction } from './actions';

export const dynamic = 'force-dynamic';

const STATUS_LABEL: Record<string, string> = {
  active: 'Active',
  completed: 'Completed',
  terminated: 'Terminated',
};

const TIER_LABEL: Record<string, string> = {
  prime: 'Prime',
  subcontract: 'Subcontract',
  task_order: 'Task order',
};

export default async function ContractListPage() {
  const { company } = await requireCompany();
  const [rows, awardable] = await Promise.all([
    listContracts(company.id),
    listAwardableCaptures(company.id),
  ]);

  const active = rows.filter((r) => r.status === 'active');
  const archived = rows.filter((r) => r.status !== 'active');
  const readyToCreate = awardable.filter((a) => !a.existingContractId);

  return (
    <div className="mx-auto max-w-5xl px-8 py-10">
      <header className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Contract</h1>
          <p className="mt-1 text-sm text-[color:var(--color-muted-foreground)]">
            Track awards, parent contracts, task orders, and subcontracts. Record obligations and
            deliverables so nothing slips after the win.
          </p>
        </div>
        <Link
          href="/contract/new"
          className="rounded-[var(--radius-md)] bg-[color:var(--color-foreground)] px-4 py-2 text-sm font-medium text-[color:var(--color-background)]"
        >
          New contract
        </Link>
      </header>

      {readyToCreate.length > 0 && (
        <section className="mb-8">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
            Won pursuits without a contract ({readyToCreate.length})
          </h2>
          <div className="space-y-2">
            {readyToCreate.map((a) => (
              <div
                key={a.pursuitId}
                className="flex items-center gap-4 rounded-[var(--radius-lg)] border border-dashed border-[color:var(--color-border)] p-4"
              >
                <div className="flex-1">
                  <p className="text-sm font-medium">{a.opportunityTitle}</p>
                  <p className="mt-0.5 text-xs text-[color:var(--color-muted-foreground)]">
                    {a.agencyName ?? a.jurisdictionName}
                    {a.valueEstimate && (
                      <> · {formatMoney(a.valueEstimate, a.currency) ?? ''}</>
                    )}
                  </p>
                </div>
                <form action={createContractFromPursuitAction}>
                  <input type="hidden" name="pursuitId" value={a.pursuitId} />
                  <button
                    type="submit"
                    className="rounded-[var(--radius-md)] border border-[color:var(--color-border)] px-3 py-1.5 text-xs font-medium hover:bg-[color:var(--color-muted)]/40"
                  >
                    Create contract →
                  </button>
                </form>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="mb-10">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
          Active ({active.length})
        </h2>
        {active.length === 0 ? (
          <div className="rounded-[var(--radius-lg)] border border-dashed border-[color:var(--color-border)] p-10 text-center text-sm text-[color:var(--color-muted-foreground)]">
            No active contracts yet.
          </div>
        ) : (
          <div className="space-y-2">
            {active.map((r) => (
              <Row key={r.id} row={r} />
            ))}
          </div>
        )}
      </section>

      {archived.length > 0 && (
        <section>
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
            Completed / terminated ({archived.length})
          </h2>
          <div className="space-y-2">
            {archived.map((r) => (
              <Row key={r.id} row={r} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function Row({ row }: { row: ContractListRow }) {
  const total = formatMoney(row.totalValue, row.currency);
  return (
    <Link
      href={`/contract/${row.id}`}
      className="flex items-center gap-4 rounded-[var(--radius-lg)] border border-[color:var(--color-border)] p-4 transition hover:border-[color:var(--color-foreground)]"
    >
      <div className="flex-1">
        <p className="text-sm font-medium">{row.awardTitle}</p>
        <p className="mt-0.5 text-xs text-[color:var(--color-muted-foreground)]">
          {TIER_LABEL[row.tier] ?? row.tier}
          {row.contractNumber && <> · {row.contractNumber}</>}
          {row.awardingAgency && <> · {row.awardingAgency}</>}
        </p>
      </div>
      <div className="text-right text-xs">
        <p className="font-medium">{total ?? '—'}</p>
        <p className="text-[color:var(--color-muted-foreground)]">
          {STATUS_LABEL[row.status] ?? row.status}
          {row.endDate && <> · ends {formatDate(new Date(row.endDate))}</>}
        </p>
        {row.obligationCount > 0 && (
          <p className="text-[color:var(--color-muted-foreground)]">
            {row.openObligationCount}/{row.obligationCount} obligations open
          </p>
        )}
      </div>
    </Link>
  );
}
