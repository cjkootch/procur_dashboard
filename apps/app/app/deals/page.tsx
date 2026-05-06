import Link from 'next/link';
import { requireCompany } from '@procur/auth';
import { listDeals } from '@procur/catalog';

export const dynamic = 'force-dynamic';

const STATUS_TONE: Record<string, string> = {
  draft: 'bg-[color:var(--color-muted)]/60',
  negotiating: 'bg-blue-100 text-blue-900',
  pending_approval: 'bg-yellow-100 text-yellow-900',
  approved: 'bg-green-100 text-green-900',
  loading: 'bg-blue-100 text-blue-900',
  in_transit: 'bg-blue-100 text-blue-900',
  delivered: 'bg-green-100 text-green-900',
  settled: 'bg-green-100 text-green-900',
  cancelled: 'bg-red-100 text-red-900',
  failed: 'bg-red-100 text-red-900',
};

/**
 * Deals index per docs/vex-into-procur-merge-brief.md Phase 5. Fuel
 * deals are procur's port of vex's deal-execution surface — the
 * highest-value capability of the merge. Calculator runs via
 * DealEvaluatorAgent; market context via DealMarketContextAgent.
 */
export default async function DealsPage() {
  await requireCompany();
  const rows = await listDeals({ limit: 100 });

  return (
    <div className="mx-auto max-w-5xl px-8 py-10">
      <header className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Deals</h1>
          <p className="mt-1 text-sm text-[color:var(--color-muted-foreground)]">
            Fuel and food deals. Each carries a cost stack, scenario(s),
            calculator results, and procur-sourced market context.
          </p>
        </div>
        <Link
          href="/leads"
          className="text-sm text-[color:var(--color-muted-foreground)] underline hover:text-[color:var(--color-foreground)]"
        >
          ← Leads
        </Link>
      </header>

      {rows.length === 0 ? (
        <div className="rounded-[var(--radius-lg)] border border-dashed border-[color:var(--color-border)] p-10 text-center text-sm text-[color:var(--color-muted-foreground)]">
          No deals yet. Create one through the chat assistant via the
          <code className="mx-1">crm.create_deal</code> action.
        </div>
      ) : (
        <div className="space-y-2">
          {rows.map((row) => (
            <Link
              key={row.id}
              href={`/deals/${row.id}`}
              className="flex items-start gap-4 rounded-[var(--radius-lg)] border border-[color:var(--color-border)] p-4 transition hover:border-[color:var(--color-foreground)]"
            >
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-sm font-medium">
                    {row.dealRef}
                  </span>
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_TONE[row.status] ?? ''}`}
                  >
                    {row.status.replace(/_/g, ' ')}
                  </span>
                  <span className="rounded-full bg-[color:var(--color-muted)]/60 px-2 py-0.5 text-xs">
                    {row.product}
                  </span>
                  {row.complianceHold && (
                    <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-900">
                      compliance hold
                    </span>
                  )}
                </div>
                <p className="mt-1 text-xs text-[color:var(--color-muted-foreground)]">
                  Buyer: {row.buyerLegalName ?? row.buyerOrgId}
                  {' · '}
                  {(row.volumeUsg / 1_000_000).toFixed(2)}M USG
                  {row.destinationPort && <> · {row.destinationPort}</>}
                  {row.laycanStart && (
                    <> · laycan {row.laycanStart}</>
                  )}
                </p>
              </div>
              <time
                className="shrink-0 text-xs text-[color:var(--color-muted-foreground)]"
                dateTime={row.createdAt.toISOString()}
              >
                {row.createdAt.toLocaleDateString()}
              </time>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
