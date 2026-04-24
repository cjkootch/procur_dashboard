import Link from 'next/link';
import { requireCompany } from '@procur/auth';
import { listCompanyProposals, type ProposalListRow } from '../../lib/proposal-queries';
import { flagFor, formatDate } from '../../lib/format';

export const dynamic = 'force-dynamic';

const STATUS_LABEL: Record<string, string> = {
  drafting: 'Drafting',
  outline_ready: 'Outline Ready',
  in_review: 'In Review',
  finalized: 'Finalized',
  submitted: 'Submitted',
};

const STATUS_CLASS: Record<string, string> = {
  drafting: 'bg-[color:var(--color-muted)]/60 text-[color:var(--color-foreground)]',
  outline_ready: 'bg-amber-500/15 text-amber-700',
  in_review: 'bg-blue-500/15 text-blue-700',
  finalized: 'bg-emerald-500/15 text-emerald-700',
  submitted: 'bg-slate-700/15 text-slate-700',
};

type Sort = 'deadline' | 'updated' | 'name' | 'status';
type Dir = 'asc' | 'desc';

type SearchParams = {
  sort?: string;
  dir?: string;
  status?: string;
  type?: string;
};

export default async function ProposalListPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await searchParams;
  const sort: Sort = (['deadline', 'updated', 'name', 'status'].includes(sp.sort ?? '')
    ? sp.sort
    : 'deadline') as Sort;
  const dir: Dir = sp.dir === 'desc' ? 'desc' : 'asc';
  const statusFilter = sp.status && sp.status !== 'all' ? sp.status : null;
  const typeFilter = sp.type && sp.type !== 'all' ? sp.type : null;

  const { company } = await requireCompany();
  const allRows = await listCompanyProposals(company.id);

  const rows = allRows.filter((r) => {
    if (statusFilter) {
      if (statusFilter === 'not_started' && r.proposalId) return false;
      if (statusFilter !== 'not_started' && r.status !== statusFilter) return false;
    }
    if (typeFilter && (r.opportunityType ?? '').toLowerCase() !== typeFilter.toLowerCase()) {
      return false;
    }
    return true;
  });

  rows.sort(sorter(sort, dir));

  const types = Array.from(
    new Set(allRows.map((r) => r.opportunityType).filter((t): t is string => !!t)),
  ).sort();

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b border-[color:var(--color-border)] bg-[color:var(--color-background)] px-6 py-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Active Proposals</h1>
          <p className="mt-0.5 text-xs text-[color:var(--color-muted-foreground)]">
            {rows.length} of {allRows.length} proposals
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs">
          <Link
            href="/capture/pipeline"
            className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] px-3 py-1.5 text-[color:var(--color-muted-foreground)] hover:bg-[color:var(--color-muted)]/40"
          >
            Pipeline
          </Link>
          <Link
            href="/capture/pursuits"
            className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] px-3 py-1.5 text-[color:var(--color-muted-foreground)] hover:bg-[color:var(--color-muted)]/40"
          >
            Drafts
          </Link>
          <Link
            href="/capture/new"
            className="rounded-[var(--radius-sm)] bg-[color:var(--color-foreground)] px-3 py-1.5 font-medium text-[color:var(--color-background)]"
          >
            + Start a new proposal
          </Link>
        </div>
      </header>

      <form method="get" className="flex items-center gap-2 border-b border-[color:var(--color-border)] px-6 py-2.5 text-xs">
        <FilterSelect
          name="type"
          label="Type"
          current={sp.type ?? 'all'}
          options={[
            { value: 'all', label: 'All types' },
            ...types.map((t) => ({ value: t, label: t })),
          ]}
        />
        <FilterSelect
          name="status"
          label="Status"
          current={sp.status ?? 'all'}
          options={[
            { value: 'all', label: 'All statuses' },
            { value: 'not_started', label: 'Not started' },
            { value: 'drafting', label: 'Drafting' },
            { value: 'outline_ready', label: 'Outline ready' },
            { value: 'in_review', label: 'In review' },
            { value: 'finalized', label: 'Finalized' },
            { value: 'submitted', label: 'Submitted' },
          ]}
        />
        <input type="hidden" name="sort" value={sort} />
        <input type="hidden" name="dir" value={dir} />
        <button
          type="submit"
          className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] px-2 py-1"
        >
          Apply
        </button>
        {(statusFilter || typeFilter) && (
          <Link
            href="/proposal"
            className="text-[color:var(--color-muted-foreground)] hover:underline"
          >
            Clear
          </Link>
        )}
      </form>

      <div className="flex-1 overflow-auto">
        {rows.length === 0 ? (
          <div className="p-10 text-center text-sm text-[color:var(--color-muted-foreground)]">
            No proposals match these filters.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-[color:var(--color-background)] text-left text-xs uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
              <tr className="border-b border-[color:var(--color-border)]">
                <SortableHeader label="Name" field="name" currentSort={sort} currentDir={dir} sp={sp} />
                <SortableHeader label="Status" field="status" currentSort={sort} currentDir={dir} sp={sp} />
                <SortableHeader label="Last Updated" field="updated" currentSort={sort} currentDir={dir} sp={sp} />
                <th className="px-4 py-2 font-medium">Agency / Department</th>
                <SortableHeader label="Due" field="deadline" currentSort={sort} currentDir={dir} sp={sp} />
                <th className="px-4 py-2 font-medium">Type</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <ProposalRow key={r.pursuitId} row={r} />
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function SortableHeader({
  label,
  field,
  currentSort,
  currentDir,
  sp,
}: {
  label: string;
  field: Sort;
  currentSort: Sort;
  currentDir: Dir;
  sp: SearchParams;
}) {
  const active = currentSort === field;
  const nextDir: Dir = active && currentDir === 'asc' ? 'desc' : 'asc';
  const params = new URLSearchParams();
  params.set('sort', field);
  params.set('dir', nextDir);
  if (sp.status) params.set('status', sp.status);
  if (sp.type) params.set('type', sp.type);
  return (
    <th className="px-4 py-2 font-medium">
      <Link href={`/proposal?${params.toString()}`} className="inline-flex items-center gap-1 hover:text-[color:var(--color-foreground)]">
        {label}
        {active && <span className="text-[10px]">{currentDir === 'asc' ? '▲' : '▼'}</span>}
      </Link>
    </th>
  );
}

function ProposalRow({ row }: { row: ProposalListRow }) {
  const statusKey = row.proposalId ? row.status ?? 'drafting' : 'not_started';
  const statusLabel = row.proposalId
    ? STATUS_LABEL[row.status ?? 'drafting'] ?? row.status ?? 'Drafting'
    : 'Not started';
  const statusClass = STATUS_CLASS[statusKey] ?? 'bg-[color:var(--color-muted)]/40';

  const compliancePct =
    row.complianceTotalCount > 0
      ? Math.round((row.complianceAddressedCount / row.complianceTotalCount) * 100)
      : null;

  return (
    <tr className="border-b border-[color:var(--color-border)]/50 transition hover:bg-[color:var(--color-muted)]/30">
      <td className="max-w-xl px-4 py-3">
        <Link href={`/proposal/${row.pursuitId}`} className="block">
          <div className="flex items-center gap-2">
            <span className="text-base leading-none">{flagFor(row.jurisdictionCountry)}</span>
            <span className="truncate font-medium">{row.opportunityTitle}</span>
          </div>
          {compliancePct != null && (
            <div className="mt-0.5 text-[11px] text-[color:var(--color-muted-foreground)]">
              {row.sectionsCount} section{row.sectionsCount === 1 ? '' : 's'} · {compliancePct}% mapped
            </div>
          )}
        </Link>
      </td>
      <td className="px-4 py-3">
        <span
          className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${statusClass}`}
        >
          {statusLabel}
        </span>
      </td>
      <td className="px-4 py-3 text-xs text-[color:var(--color-muted-foreground)]">
        {humanRelative(row.updatedAt)}
      </td>
      <td className="max-w-xs truncate px-4 py-3 text-xs text-[color:var(--color-muted-foreground)]">
        {row.agencyName ?? row.jurisdictionName}
      </td>
      <td className="px-4 py-3 text-xs">
        {row.deadlineAt ? (
          <span className={dueClass(row.deadlineAt)}>{dueLabel(row.deadlineAt)}</span>
        ) : (
          <span className="text-[color:var(--color-muted-foreground)]">—</span>
        )}
      </td>
      <td className="px-4 py-3 text-xs">
        {row.opportunityType ? (
          <span className="inline-flex rounded-[var(--radius-sm)] border border-[color:var(--color-border)] px-1.5 py-0.5 text-[10px] uppercase tracking-wide">
            {row.opportunityType}
          </span>
        ) : (
          <span className="text-[color:var(--color-muted-foreground)]">—</span>
        )}
      </td>
    </tr>
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

function sorter(sort: Sort, dir: Dir) {
  const mul = dir === 'asc' ? 1 : -1;
  return (a: ProposalListRow, b: ProposalListRow) => {
    switch (sort) {
      case 'name':
        return mul * a.opportunityTitle.localeCompare(b.opportunityTitle);
      case 'updated':
        return mul * (a.updatedAt.getTime() - b.updatedAt.getTime());
      case 'status': {
        const sa = a.proposalId ? a.status ?? 'drafting' : 'not_started';
        const sb = b.proposalId ? b.status ?? 'drafting' : 'not_started';
        return mul * sa.localeCompare(sb);
      }
      case 'deadline':
      default: {
        // Rows without a deadline sort to the bottom regardless of direction.
        const at = a.deadlineAt?.getTime() ?? Number.POSITIVE_INFINITY;
        const bt = b.deadlineAt?.getTime() ?? Number.POSITIVE_INFINITY;
        return mul * (at - bt);
      }
    }
  };
}

function humanRelative(d: Date): string {
  const diff = Date.now() - d.getTime();
  const hours = Math.round(diff / 3_600_000);
  if (hours < 1) return 'Just now';
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  if (days < 14) return `${days} day${days === 1 ? '' : 's'} ago`;
  return formatDate(d);
}

function dueLabel(d: Date): string {
  const diff = d.getTime() - Date.now();
  if (diff < 0) return 'Overdue';
  const days = Math.round(diff / (24 * 3_600_000));
  if (days <= 3) return 'Due Soon';
  if (days < 14) return `Due in ${days} days`;
  const weeks = Math.round(days / 7);
  if (weeks < 8) return `Due in ${weeks} week${weeks === 1 ? '' : 's'}`;
  return formatDate(d);
}

function dueClass(d: Date): string {
  const diff = d.getTime() - Date.now();
  if (diff < 0) return 'text-red-600 font-medium';
  const days = diff / (24 * 3_600_000);
  if (days <= 3) return 'text-amber-700 font-medium';
  return 'text-[color:var(--color-muted-foreground)]';
}
