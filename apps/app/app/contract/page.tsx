import Link from 'next/link';
import { requireCompany } from '@procur/auth';
import {
  listAwardableCaptures,
  listContracts,
  type ContractListRow,
} from '../../lib/contract-queries';
import { formatDate, formatMoney } from '../../lib/format';
import { createContractFromPursuitAction } from './actions';
import { ComplianceChip, StatusChip, TierChip } from './components/chips';

export const dynamic = 'force-dynamic';

type Layout = 'table' | 'rows';
type SearchParams = {
  layout?: string;
  tier?: string;
  status?: string;
  q?: string;
};

function isLayout(v: string | undefined): v is Layout {
  return v === 'table' || v === 'rows';
}

/**
 * Substring-match a contract row against a query string. Case-insensitive.
 * Match across the fields a user is likely to remember: award title,
 * agency, contract / task-order / parent / subcontract numbers.
 */
function contractMatches(r: ContractListRow, q: string): boolean {
  const needle = q.trim().toLowerCase();
  if (needle.length === 0) return true;
  const haystack = [
    r.awardTitle,
    r.awardingAgency,
    r.contractNumber,
    r.parentContractNumber,
    r.taskOrderNumber,
    r.subcontractNumber,
  ]
    .filter(Boolean)
    .join('  ')
    .toLowerCase();
  return haystack.includes(needle);
}

export default async function ContractListPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await searchParams;
  const layout: Layout = isLayout(sp.layout) ? sp.layout : 'table';
  const tierFilter = sp.tier && sp.tier !== 'all' ? sp.tier : null;
  const statusFilter = sp.status && sp.status !== 'all' ? sp.status : null;
  const q = (sp.q ?? '').trim();

  const { company } = await requireCompany();
  const [allRows, awardable] = await Promise.all([
    listContracts(company.id),
    listAwardableCaptures(company.id),
  ]);

  const rows = allRows.filter((r) => {
    if (tierFilter && r.tier !== tierFilter) return false;
    if (statusFilter && r.status !== statusFilter) return false;
    if (q && !contractMatches(r, q)) return false;
    return true;
  });

  const readyToCreate = awardable.filter((a) => !a.existingContractId);

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b border-[color:var(--color-border)] bg-[color:var(--color-background)] px-6 py-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Contract Inventory</h1>
          <p className="mt-0.5 text-xs text-[color:var(--color-muted-foreground)]">
            {rows.length} of {allRows.length} contracts
            {q && (
              <>
                {' '}· matching <span className="font-medium">&ldquo;{q}&rdquo;</span>
              </>
            )}
            {' '}· track awards, task orders, and subcontracts; record obligations
            so nothing slips after the win
          </p>
        </div>
        <div className="flex items-center gap-2">
          <LayoutToggle current={layout} sp={sp} />
          <Link
            href="/contract/reports"
            className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] px-3 py-1.5 text-xs hover:bg-[color:var(--color-muted)]/40"
          >
            Reports
          </Link>
          <a
            href={`/api/contract/export.csv`}
            className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] px-3 py-1.5 text-xs hover:bg-[color:var(--color-muted)]/40"
          >
            Export
          </a>
          <Link
            href="/contract/new"
            className="rounded-[var(--radius-sm)] bg-[color:var(--color-foreground)] px-3 py-1.5 text-xs font-medium text-[color:var(--color-background)]"
          >
            + Add New Contract
          </Link>
        </div>
      </header>

      {/* Filter toolbar */}
      <form
        method="get"
        className="flex flex-wrap items-center gap-2 border-b border-[color:var(--color-border)] px-6 py-2 text-xs"
      >
        <input
          type="search"
          name="q"
          defaultValue={q}
          placeholder="Search by title, agency, contract #…"
          className="min-w-[14rem] flex-1 rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1 text-xs focus:border-[color:var(--color-foreground)] focus:outline-none"
        />
        <FilterSelect
          name="tier"
          label="Tier"
          current={sp.tier ?? 'all'}
          options={[
            { value: 'all', label: 'All tiers' },
            { value: 'prime', label: 'Prime' },
            { value: 'subcontract', label: 'Subcontract' },
            { value: 'task_order', label: 'Task Order' },
          ]}
        />
        <FilterSelect
          name="status"
          label="Status"
          current={sp.status ?? 'all'}
          options={[
            { value: 'all', label: 'All statuses' },
            { value: 'active', label: 'Active' },
            { value: 'completed', label: 'Completed' },
            { value: 'terminated', label: 'Terminated' },
          ]}
        />
        <input type="hidden" name="layout" value={layout} />
        <button
          type="submit"
          className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] px-2 py-1"
        >
          Apply
        </button>
        {(tierFilter || statusFilter || q) && (
          <Link
            href={`/contract?layout=${layout}`}
            className="text-[color:var(--color-muted-foreground)] hover:underline"
          >
            Clear
          </Link>
        )}
      </form>

      {/* Awardable pursuits callout */}
      {readyToCreate.length > 0 && (
        <div className="border-b border-[color:var(--color-border)] bg-amber-500/10 px-6 py-3">
          <p className="text-xs font-medium">
            {readyToCreate.length} won pursuit
            {readyToCreate.length === 1 ? '' : 's'} without a contract
          </p>
          <ul className="mt-1 flex flex-wrap gap-2">
            {readyToCreate.slice(0, 6).map((a) => (
              <li key={a.pursuitId}>
                <form action={createContractFromPursuitAction} className="inline-flex">
                  <input type="hidden" name="pursuitId" value={a.pursuitId} />
                  <button
                    type="submit"
                    className="rounded-[var(--radius-sm)] bg-[color:var(--color-background)] px-2 py-0.5 text-[11px] hover:bg-[color:var(--color-muted)]/60"
                  >
                    + Create contract · {a.opportunityTitle.slice(0, 50)}
                    {a.opportunityTitle.length > 50 ? '…' : ''}
                  </button>
                </form>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex-1 overflow-auto">
        {rows.length === 0 ? (
          <div className="p-10 text-center text-sm text-[color:var(--color-muted-foreground)]">
            No contracts match these filters.
          </div>
        ) : layout === 'table' ? (
          <TableView rows={rows} />
        ) : (
          <RowsView rows={rows} />
        )}
      </div>
    </div>
  );
}

// -- Table view (dense, many columns) ----------------------------------------

function TableView({ rows }: { rows: ContractListRow[] }) {
  return (
    <table className="w-full text-sm">
      <thead className="sticky top-0 bg-[color:var(--color-background)] text-left text-[11px] uppercase tracking-wider text-[color:var(--color-muted-foreground)]">
        <tr className="border-b border-[color:var(--color-border)]">
          <th className="px-4 py-2 font-medium">Award Title</th>
          <th className="px-4 py-2 font-medium">Tier</th>
          <th className="px-4 py-2 font-medium">Contract Number</th>
          <th className="px-4 py-2 font-medium">Parent / Task Order</th>
          <th className="px-4 py-2 font-medium">Agency</th>
          <th className="px-4 py-2 font-medium">Period</th>
          <th className="px-4 py-2 text-right font-medium">Value</th>
          <th className="px-4 py-2 font-medium">Compliance</th>
          <th className="px-4 py-2 font-medium">Status</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr
            key={r.id}
            className="border-b border-[color:var(--color-border)]/50 transition hover:bg-[color:var(--color-muted)]/30"
          >
            <td className="max-w-md px-4 py-3">
              <Link href={`/contract/${r.id}`} className="truncate font-medium hover:underline">
                {r.awardTitle}
              </Link>
            </td>
            <td className="px-4 py-3">
              <TierChip tier={r.tier} />
            </td>
            <td className="max-w-xs truncate px-4 py-3 font-mono text-xs text-[color:var(--color-muted-foreground)]">
              {r.contractNumber ?? '—'}
            </td>
            <td className="px-4 py-3 text-xs text-[color:var(--color-muted-foreground)]">
              {r.parentContractNumber && (
                <div className="truncate">Parent: {r.parentContractNumber}</div>
              )}
              {r.taskOrderNumber && <div className="truncate">TO: {r.taskOrderNumber}</div>}
              {r.subcontractNumber && <div className="truncate">Sub: {r.subcontractNumber}</div>}
              {!r.parentContractNumber && !r.taskOrderNumber && !r.subcontractNumber && '—'}
            </td>
            <td className="max-w-xs truncate px-4 py-3 text-xs text-[color:var(--color-muted-foreground)]">
              {r.awardingAgency ?? '—'}
            </td>
            <td className="px-4 py-3 text-xs text-[color:var(--color-muted-foreground)]">
              {r.startDate ? formatDate(new Date(r.startDate)) : '—'}
              {r.endDate && <> → {formatDate(new Date(r.endDate))}</>}
            </td>
            <td className="px-4 py-3 text-right">
              <div className="font-medium">{formatMoney(r.totalValue, r.currency) ?? '—'}</div>
              {r.totalValueUsd && r.currency !== 'USD' && (
                <div className="text-[10px] text-[color:var(--color-muted-foreground)]">
                  ≈ {formatMoney(r.totalValueUsd, 'USD')}
                </div>
              )}
            </td>
            <td className="px-4 py-3">
              <ComplianceChip state={r.compliance} />
              {r.overdueObligationCount > 0 && (
                <div className="mt-0.5 text-[10px] text-red-600">
                  {r.overdueObligationCount} overdue
                </div>
              )}
            </td>
            <td className="px-4 py-3">
              <StatusChip status={r.status} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// -- Rows view (card-style, keeps old density for narrow screens / text view) -

function RowsView({ rows }: { rows: ContractListRow[] }) {
  return (
    <div className="space-y-2 px-6 py-4">
      {rows.map((r) => (
        <Link
          key={r.id}
          href={`/contract/${r.id}`}
          className="flex items-start gap-4 rounded-[var(--radius-md)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] p-4 transition hover:border-[color:var(--color-foreground)]/40 hover:shadow-sm"
        >
          <div className="flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-sm font-medium">{r.awardTitle}</p>
              <TierChip tier={r.tier} />
              <StatusChip status={r.status} />
              <ComplianceChip state={r.compliance} />
            </div>
            <p className="mt-1 text-xs text-[color:var(--color-muted-foreground)]">
              {r.contractNumber && <span className="font-mono">{r.contractNumber}</span>}
              {r.awardingAgency && <> · {r.awardingAgency}</>}
              {r.startDate && (
                <>
                  {' · '}
                  {formatDate(new Date(r.startDate))}
                  {r.endDate && <> → {formatDate(new Date(r.endDate))}</>}
                </>
              )}
            </p>
            {(r.parentContractNumber || r.taskOrderNumber || r.subcontractNumber) && (
              <p className="mt-0.5 text-[11px] text-[color:var(--color-muted-foreground)]">
                {r.parentContractNumber && <>Parent: {r.parentContractNumber} · </>}
                {r.taskOrderNumber && <>TO: {r.taskOrderNumber} · </>}
                {r.subcontractNumber && <>Sub: {r.subcontractNumber}</>}
              </p>
            )}
          </div>
          <div className="text-right text-xs">
            <p className="font-semibold">{formatMoney(r.totalValue, r.currency) ?? '—'}</p>
            {r.totalValueUsd && r.currency !== 'USD' && (
              <p className="text-[10px] text-[color:var(--color-muted-foreground)]">
                ≈ {formatMoney(r.totalValueUsd, 'USD')}
              </p>
            )}
            {r.obligationCount > 0 && (
              <p className="mt-1 text-[color:var(--color-muted-foreground)]">
                {r.openObligationCount}/{r.obligationCount} obligations open
                {r.overdueObligationCount > 0 && (
                  <span className="ml-1 text-red-600">({r.overdueObligationCount} overdue)</span>
                )}
              </p>
            )}
          </div>
        </Link>
      ))}
    </div>
  );
}

// -- Toolbar bits ------------------------------------------------------------

function LayoutToggle({ current, sp }: { current: Layout; sp: SearchParams }) {
  function href(layout: Layout) {
    const params = new URLSearchParams();
    params.set('layout', layout);
    if (sp.tier && sp.tier !== 'all') params.set('tier', sp.tier);
    if (sp.status && sp.status !== 'all') params.set('status', sp.status);
    if (sp.q) params.set('q', sp.q);
    return `/contract?${params.toString()}`;
  }
  return (
    <div className="inline-flex rounded-[var(--radius-sm)] border border-[color:var(--color-border)] p-0.5 text-xs">
      <Link
        href={href('table')}
        className={`rounded-[var(--radius-sm)] px-2.5 py-1 ${
          current === 'table'
            ? 'bg-[color:var(--color-foreground)] text-[color:var(--color-background)]'
            : 'text-[color:var(--color-muted-foreground)]'
        }`}
      >
        Table
      </Link>
      <Link
        href={href('rows')}
        className={`rounded-[var(--radius-sm)] px-2.5 py-1 ${
          current === 'rows'
            ? 'bg-[color:var(--color-foreground)] text-[color:var(--color-background)]'
            : 'text-[color:var(--color-muted-foreground)]'
        }`}
      >
        Rows
      </Link>
    </div>
  );
}

function FilterSelect({
  name,
  label,
  current,
  options,
}: {
  name: string;
  label: string;
  current: string;
  options: Array<{ value: string; label: string }>;
}) {
  return (
    <label className="flex items-center gap-1">
      <span className="text-[color:var(--color-muted-foreground)]">{label}:</span>
      <select
        name={name}
        defaultValue={current}
        className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1 text-xs"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}
