import Link from 'next/link';
import { requireCompany } from '@procur/auth';
import { listLeads } from '@procur/catalog';

export const dynamic = 'force-dynamic';

const STATUS_TONE: Record<string, string> = {
  new: 'bg-blue-100 text-blue-900',
  qualified: 'bg-green-100 text-green-900',
  disqualified: 'bg-[color:var(--color-muted)]/60',
  won: 'bg-green-100 text-green-900',
  lost: 'bg-red-100 text-red-900',
};

/**
 * Leads index per docs/vex-into-procur-merge-brief.md Phase 4.
 * Replaces the deleted vex CRM lead view; data now lives in
 * procur's own `leads` table populated by `qualifyAsLead()`.
 */
export default async function LeadsPage() {
  await requireCompany();
  const rows = await listLeads({ limit: 100 });

  return (
    <div className="mx-auto max-w-5xl px-4 py-6 md:px-8 md:py-10">
      <header className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Leads</h1>
          <p className="mt-1 text-sm text-[color:var(--color-muted-foreground)]">
            Counterparties qualified from the match queue, entity profile, or
            assistant chat. The full procur metadata (signals, market context,
            spec docs) lives on each lead row.
          </p>
        </div>
        <div className="flex gap-3 text-sm">
          <Link
            href="/campaigns"
            className="text-[color:var(--color-muted-foreground)] underline hover:text-[color:var(--color-foreground)]"
          >
            Campaigns →
          </Link>
          <Link
            href="/follow-ups"
            className="text-[color:var(--color-muted-foreground)] underline hover:text-[color:var(--color-foreground)]"
          >
            Follow-ups →
          </Link>
        </div>
      </header>

      {rows.length === 0 ? (
        <div className="rounded-[var(--radius-lg)] border border-dashed border-[color:var(--color-border)] p-10 text-center text-sm text-[color:var(--color-muted-foreground)]">
          No leads yet. Qualify counterparties from the match queue or entity
          profiles to populate this list.
        </div>
      ) : (
        <div className="space-y-2">
          {rows.map((row) => (
            <Link
              key={row.id}
              href={`/leads/${row.id}`}
              className="flex items-start gap-4 rounded-[var(--radius-lg)] border border-[color:var(--color-border)] p-4 transition hover:border-[color:var(--color-foreground)]"
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium">
                    {row.orgLegalName}
                  </span>
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_TONE[row.status] ?? ''}`}
                  >
                    {row.status}
                  </span>
                  {row.stage && (
                    <span className="rounded-full bg-[color:var(--color-muted)]/60 px-2 py-0.5 text-xs">
                      {row.stage}
                    </span>
                  )}
                </div>
                {row.qualificationSummary && (
                  <p className="mt-1 line-clamp-2 text-xs text-[color:var(--color-muted-foreground)]">
                    {row.qualificationSummary}
                  </p>
                )}
                {row.contactFullName && (
                  <p className="mt-0.5 text-xs text-[color:var(--color-muted-foreground)]">
                    Contact: {row.contactFullName}
                  </p>
                )}
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
