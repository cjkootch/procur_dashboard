import Link from 'next/link';
import { requireCompany } from '@procur/auth';
import { listPendingApprovals } from '@procur/catalog';
import { approveApprovalAction, rejectApprovalAction } from './actions';

export const dynamic = 'force-dynamic';

/**
 * Approval queue per docs/vex-into-procur-merge-brief.md Phase 2.
 * Lists pending approvals authored by AgentRunner-routed T2+ actions.
 * Approve/reject buttons record the decision; the per-domain executor
 * that applies the side effect (email send, deal create, …) lands in
 * Phase 3+ alongside the agents that produce those actions.
 */
export default async function ApprovalsPage() {
  await requireCompany();
  const rows = await listPendingApprovals({ limit: 50 });

  return (
    <div className="mx-auto max-w-5xl px-4 py-6 md:px-8 md:py-10">
      <header className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Approvals</h1>
          <p className="mt-1 text-sm text-[color:var(--color-muted-foreground)]">
            Pending agent-proposed actions. T2+ actions never execute inline —
            review the typed payload and decide before the executor applies it.
          </p>
        </div>
        <Link
          href="/agent-runs"
          className="text-sm text-[color:var(--color-muted-foreground)] underline hover:text-[color:var(--color-foreground)]"
        >
          Agent runs →
        </Link>
      </header>

      {rows.length === 0 ? (
        <div className="rounded-[var(--radius-lg)] border border-dashed border-[color:var(--color-border)] p-10 text-center text-sm text-[color:var(--color-muted-foreground)]">
          No pending approvals. Agent-proposed T2+ actions will appear here for
          review.
        </div>
      ) : (
        <div className="space-y-2">
          {rows.map((row) => {
            const tier =
              typeof row.proposedPayload?.['tier'] === 'string'
                ? (row.proposedPayload['tier'] as string)
                : '';
            const rationale =
              typeof row.proposedPayload?.['rationale'] === 'string'
                ? (row.proposedPayload['rationale'] as string)
                : null;
            return (
              <div
                key={row.id}
                className="flex items-start gap-4 rounded-[var(--radius-lg)] border border-[color:var(--color-border)] p-4 transition hover:border-[color:var(--color-foreground)]"
              >
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <Link
                      href={`/approvals/${row.id}`}
                      className="font-mono text-sm font-medium hover:underline"
                    >
                      {row.actionType}
                    </Link>
                    {tier && (
                      <span className="rounded-full bg-[color:var(--color-muted)]/60 px-2 py-0.5 text-xs font-medium">
                        {tier}
                      </span>
                    )}
                    <time
                      className="ml-auto text-xs text-[color:var(--color-muted-foreground)]"
                      dateTime={row.createdAt.toISOString()}
                    >
                      {row.createdAt.toLocaleString()}
                    </time>
                  </div>
                  {rationale && (
                    <p className="mt-1 text-sm text-[color:var(--color-muted-foreground)]">
                      {rationale}
                    </p>
                  )}
                </div>
                <div className="flex shrink-0 gap-2">
                  <form action={approveApprovalAction}>
                    <input type="hidden" name="id" value={row.id} />
                    <button
                      type="submit"
                      className="rounded-[var(--radius-md)] bg-[color:var(--color-foreground)] px-3 py-1.5 text-xs font-medium text-[color:var(--color-background)]"
                    >
                      Approve
                    </button>
                  </form>
                  <form action={rejectApprovalAction}>
                    <input type="hidden" name="id" value={row.id} />
                    <button
                      type="submit"
                      className="rounded-[var(--radius-md)] border border-[color:var(--color-border)] px-3 py-1.5 text-xs font-medium hover:border-[color:var(--color-foreground)]"
                    >
                      Reject
                    </button>
                  </form>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
