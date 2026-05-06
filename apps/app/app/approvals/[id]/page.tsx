import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireCompany } from '@procur/auth';
import { getApproval } from '@procur/catalog';
import {
  approveApprovalAction,
  rejectApprovalAction,
} from '../actions';

export const dynamic = 'force-dynamic';

interface PageProps {
  params: Promise<{ id: string }>;
}

/**
 * Approval detail per docs/vex-into-procur-merge-brief.md Phase 2.
 * Shows the full typed payload so the reviewer sees exactly what
 * the executor will apply when they approve. Decision metadata
 * (reviewer + decided_at) shows once the approval is no longer
 * pending.
 */
export default async function ApprovalDetailPage({ params }: PageProps) {
  await requireCompany();
  const { id } = await params;
  const row = await getApproval(id);
  if (!row) notFound();

  const isPending = row.decision === 'pending';
  const tier =
    typeof row.proposedPayload?.['tier'] === 'string'
      ? (row.proposedPayload['tier'] as string)
      : '';
  const rationale =
    typeof row.proposedPayload?.['rationale'] === 'string'
      ? (row.proposedPayload['rationale'] as string)
      : null;

  return (
    <div className="mx-auto max-w-3xl px-8 py-10">
      <Link
        href="/approvals"
        className="text-sm text-[color:var(--color-muted-foreground)] hover:underline"
      >
        ← Approvals
      </Link>

      <header className="mt-4 mb-6">
        <div className="flex items-center gap-2">
          <h1 className="font-mono text-2xl font-semibold tracking-tight">
            {row.actionType}
          </h1>
          {tier && (
            <span className="rounded-full bg-[color:var(--color-muted)]/60 px-2 py-0.5 text-xs font-medium">
              {tier}
            </span>
          )}
          <span
            className={`rounded-full px-2 py-0.5 text-xs font-medium ${
              isPending
                ? 'bg-yellow-100 text-yellow-900'
                : row.decision === 'approved'
                  ? 'bg-green-100 text-green-900'
                  : row.decision === 'rejected'
                    ? 'bg-red-100 text-red-900'
                    : 'bg-blue-100 text-blue-900'
            }`}
          >
            {row.decision}
          </span>
        </div>
        {rationale && (
          <p className="mt-2 text-sm text-[color:var(--color-muted-foreground)]">
            {rationale}
          </p>
        )}
        <p className="mt-1 text-xs text-[color:var(--color-muted-foreground)]">
          Created{' '}
          <time dateTime={row.createdAt.toISOString()}>
            {row.createdAt.toLocaleString()}
          </time>
          {row.agentRunId && (
            <>
              {' '}
              · agent run{' '}
              <Link
                href={`/agent-runs/${row.agentRunId}`}
                className="font-mono hover:underline"
              >
                {row.agentRunId.slice(0, 8)}
              </Link>
            </>
          )}
        </p>
      </header>

      <section className="rounded-[var(--radius-lg)] border border-[color:var(--color-border)] bg-[color:var(--color-muted)]/20 p-4">
        <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
          Proposed payload
        </h2>
        <pre className="overflow-x-auto whitespace-pre-wrap break-words text-xs">
          {JSON.stringify(row.proposedPayload, null, 2)}
        </pre>
      </section>

      {isPending ? (
        <div className="mt-6 flex gap-3">
          <form action={approveApprovalAction}>
            <input type="hidden" name="id" value={row.id} />
            <button
              type="submit"
              className="rounded-[var(--radius-md)] bg-[color:var(--color-foreground)] px-4 py-2 text-sm font-medium text-[color:var(--color-background)]"
            >
              Approve
            </button>
          </form>
          <form action={rejectApprovalAction}>
            <input type="hidden" name="id" value={row.id} />
            <button
              type="submit"
              className="rounded-[var(--radius-md)] border border-[color:var(--color-border)] px-4 py-2 text-sm font-medium hover:border-[color:var(--color-foreground)]"
            >
              Reject
            </button>
          </form>
        </div>
      ) : (
        <div className="mt-6 rounded-[var(--radius-lg)] border border-[color:var(--color-border)] p-4 text-sm">
          <p>
            <span className="text-[color:var(--color-muted-foreground)]">
              Decision:
            </span>{' '}
            <span className="font-medium">{row.decision}</span>
          </p>
          {row.reviewerId && (
            <p className="mt-1">
              <span className="text-[color:var(--color-muted-foreground)]">
                Reviewer:
              </span>{' '}
              <span className="font-mono">{row.reviewerId}</span>
            </p>
          )}
          {row.decidedAt && (
            <p className="mt-1">
              <span className="text-[color:var(--color-muted-foreground)]">
                Decided at:
              </span>{' '}
              <time dateTime={row.decidedAt.toISOString()}>
                {row.decidedAt.toLocaleString()}
              </time>
            </p>
          )}
          {row.appliedObjectId && (
            <p className="mt-1">
              <span className="text-[color:var(--color-muted-foreground)]">
                Applied object:
              </span>{' '}
              <span className="font-mono">{row.appliedObjectId}</span>
            </p>
          )}
        </div>
      )}
    </div>
  );
}
