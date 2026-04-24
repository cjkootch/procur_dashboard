import Link from 'next/link';
import { requireCompany } from '@procur/auth';
import { listCompanyProposals, type ProposalListRow } from '../../lib/proposal-queries';
import { flagFor, formatDate, timeUntil } from '../../lib/format';

export const dynamic = 'force-dynamic';

const STATUS_LABEL: Record<string, string> = {
  drafting: 'Drafting',
  outline_ready: 'Outline ready',
  in_review: 'In review',
  finalized: 'Finalized',
  submitted: 'Submitted',
};

export default async function ProposalListPage() {
  const { company } = await requireCompany();
  const rows = await listCompanyProposals(company.id);

  const withProposal = rows.filter((r) => r.proposalId);
  const notStarted = rows.filter((r) => !r.proposalId);

  return (
    <div className="mx-auto max-w-5xl px-8 py-10">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Proposals</h1>
        <p className="mt-1 text-sm text-[color:var(--color-muted-foreground)]">
          Pursuits at Proposal Development or later. Move a pursuit from Capture to unlock.
        </p>
      </header>

      {notStarted.length > 0 && (
        <section className="mb-10">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
            Ready to start ({notStarted.length})
          </h2>
          <div className="space-y-2">
            {notStarted.map((r) => (
              <Row key={r.pursuitId} row={r} />
            ))}
          </div>
        </section>
      )}

      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
          In progress ({withProposal.length})
        </h2>
        {withProposal.length === 0 ? (
          <div className="rounded-[var(--radius-lg)] border border-dashed border-[color:var(--color-border)] p-10 text-center text-sm text-[color:var(--color-muted-foreground)]">
            No proposals in progress yet.
          </div>
        ) : (
          <div className="space-y-2">
            {withProposal.map((r) => (
              <Row key={r.pursuitId} row={r} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function Row({ row }: { row: ProposalListRow }) {
  const countdown = timeUntil(row.deadlineAt);
  const compliancePct =
    row.complianceTotalCount > 0
      ? Math.round((row.complianceAddressedCount / row.complianceTotalCount) * 100)
      : null;
  return (
    <Link
      href={`/proposal/${row.pursuitId}`}
      className="flex items-center gap-4 rounded-[var(--radius-lg)] border border-[color:var(--color-border)] p-4 transition hover:border-[color:var(--color-foreground)]"
    >
      <span className="text-xl">{flagFor(row.jurisdictionCountry)}</span>
      <div className="flex-1">
        <p className="text-sm font-medium">{row.opportunityTitle}</p>
        <p className="mt-0.5 text-xs text-[color:var(--color-muted-foreground)]">
          {row.agencyName ?? row.jurisdictionName}
          {row.deadlineAt && <> · Closes {formatDate(row.deadlineAt)}</>}
          {countdown && countdown !== 'closed' && <> · in {countdown}</>}
        </p>
      </div>
      <div className="text-right text-xs">
        {row.proposalId ? (
          <>
            <p className="font-medium">{STATUS_LABEL[row.status ?? 'drafting'] ?? row.status}</p>
            <p className="text-[color:var(--color-muted-foreground)]">
              {row.sectionsCount} section{row.sectionsCount === 1 ? '' : 's'}
              {compliancePct != null && <> · {compliancePct}% mapped</>}
            </p>
          </>
        ) : (
          <p className="text-[color:var(--color-brand)]">Start →</p>
        )}
      </div>
    </Link>
  );
}
