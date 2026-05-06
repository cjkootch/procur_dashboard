import Link from 'next/link';
import { requireCompany } from '@procur/auth';
import { listCampaigns } from '@procur/catalog';

export const dynamic = 'force-dynamic';

const STATUS_TONE: Record<string, string> = {
  active: 'bg-green-100 text-green-900',
  paused: 'bg-[color:var(--color-muted)]/60',
  completed: 'bg-blue-100 text-blue-900',
  archived: 'bg-[color:var(--color-muted)]/40',
};

/**
 * Campaigns index per docs/vex-into-procur-merge-brief.md Phase 4.
 * Read-only for now; campaign creation arrives via the
 * `campaign.create` ActionDescriptor + ApprovalGate flow once that
 * executor lands.
 */
export default async function CampaignsPage() {
  await requireCompany();
  const rows = await listCampaigns({ limit: 100 });

  return (
    <div className="mx-auto max-w-5xl px-8 py-10">
      <header className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Campaigns</h1>
          <p className="mt-1 text-sm text-[color:var(--color-muted-foreground)]">
            Outbound orchestration plans. Step dispatchers route through the
            approval queue at the configured tier.
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
          No campaigns yet. Create one through the chat assistant via the
          <code className="mx-1">campaign.create</code> action.
        </div>
      ) : (
        <div className="space-y-2">
          {rows.map((row) => (
            <Link
              key={row.id}
              href={`/campaigns/${row.id}`}
              className="flex items-start gap-4 rounded-[var(--radius-lg)] border border-[color:var(--color-border)] p-4 transition hover:border-[color:var(--color-foreground)]"
            >
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <span className="rounded-full bg-[color:var(--color-muted)]/60 px-2 py-0.5 text-xs font-medium">
                    {row.channel}
                  </span>
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_TONE[row.status] ?? ''}`}
                  >
                    {row.status}
                  </span>
                  <span className="text-sm font-medium">{row.id}</span>
                </div>
                {row.objective && (
                  <p className="mt-1 text-xs text-[color:var(--color-muted-foreground)]">
                    {row.objective}
                  </p>
                )}
                <p className="mt-1 text-xs text-[color:var(--color-muted-foreground)]">
                  {row.stepCount} step{row.stepCount === 1 ? '' : 's'}
                  {row.spend != null && (
                    <> · ${row.spend.toFixed(0)} spend</>
                  )}
                </p>
              </div>
              <time
                className="shrink-0 text-xs text-[color:var(--color-muted-foreground)]"
                dateTime={row.updatedAt.toISOString()}
              >
                {row.updatedAt.toLocaleDateString()}
              </time>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
