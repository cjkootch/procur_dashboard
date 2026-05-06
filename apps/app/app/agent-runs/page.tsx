import Link from 'next/link';
import { requireCompany } from '@procur/auth';
import { listAgentRuns, sumCostLedgerToday } from '@procur/catalog';

export const dynamic = 'force-dynamic';

const STATUS_TONE: Record<string, string> = {
  pending: 'bg-[color:var(--color-muted)]/60',
  running: 'bg-blue-100 text-blue-900',
  completed: 'bg-green-100 text-green-900',
  failed: 'bg-red-100 text-red-900',
};

/**
 * Agent runs index per docs/vex-into-procur-merge-brief.md Phase 2.
 * Read-only list of recent AgentRunner invocations + today's cost
 * ledger total. Useful for verifying the runtime is healthy and
 * understanding which agents are spending budget. Pagination /
 * filtering deferred to later phases.
 */
export default async function AgentRunsPage() {
  await requireCompany();
  const [rows, todaysCost] = await Promise.all([
    listAgentRuns({ limit: 100 }),
    sumCostLedgerToday(),
  ]);

  return (
    <div className="mx-auto max-w-5xl px-8 py-10">
      <header className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Agent runs</h1>
          <p className="mt-1 text-sm text-[color:var(--color-muted-foreground)]">
            Recent AgentRunner invocations. Today&apos;s cost ledger:{' '}
            <span className="font-mono">${todaysCost.usd.toFixed(4)}</span>.
          </p>
        </div>
        <Link
          href="/approvals"
          className="text-sm text-[color:var(--color-muted-foreground)] underline hover:text-[color:var(--color-foreground)]"
        >
          Approvals →
        </Link>
      </header>

      {rows.length === 0 ? (
        <div className="rounded-[var(--radius-lg)] border border-dashed border-[color:var(--color-border)] p-10 text-center text-sm text-[color:var(--color-muted-foreground)]">
          No agent runs yet. Phase 3+ will land the first agents that exercise
          this runtime.
        </div>
      ) : (
        <div className="space-y-2">
          {rows.map((row) => (
            <div
              key={row.id}
              className="flex items-center gap-4 rounded-[var(--radius-lg)] border border-[color:var(--color-border)] p-4"
            >
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-sm font-medium">
                    {row.agentName}
                  </span>
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_TONE[row.status] ?? ''}`}
                  >
                    {row.status}
                  </span>
                  <time
                    className="ml-auto text-xs text-[color:var(--color-muted-foreground)]"
                    dateTime={row.createdAt.toISOString()}
                  >
                    {row.createdAt.toLocaleString()}
                  </time>
                </div>
                {row.error && (
                  <p className="mt-1 text-xs text-red-700">{row.error}</p>
                )}
              </div>
              <div className="shrink-0 text-right text-xs">
                <p className="font-mono">${row.costUsd.toFixed(4)}</p>
                <p className="text-[color:var(--color-muted-foreground)]">
                  {row.id.slice(0, 8)}
                </p>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
