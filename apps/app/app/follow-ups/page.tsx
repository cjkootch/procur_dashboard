import Link from 'next/link';
import { requireCompany } from '@procur/auth';
import { listFollowUps } from '@procur/catalog';
import { completeFollowUpAction } from './actions';

export const dynamic = 'force-dynamic';

/**
 * Follow-ups index per docs/vex-into-procur-merge-brief.md Phase 4.
 * Open follow-ups sorted by due_at; the chat agent's
 * `follow_up.schedule` action populates this list once that
 * executor lands.
 */
export default async function FollowUpsPage() {
  await requireCompany();
  const rows = await listFollowUps({ status: 'open', limit: 100 });
  const now = Date.now();

  return (
    <div className="mx-auto max-w-3xl px-8 py-10">
      <header className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Follow-ups</h1>
          <p className="mt-1 text-sm text-[color:var(--color-muted-foreground)]">
            Deferred reminders. Overdue rows sit at the top.
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
          No open follow-ups.
        </div>
      ) : (
        <ul className="space-y-2">
          {rows.map((row) => {
            const overdue = row.dueAt.getTime() < now;
            return (
              <li
                key={row.id}
                className={`flex items-start gap-3 rounded-[var(--radius-lg)] border p-4 ${
                  overdue
                    ? 'border-red-300 bg-red-50/40'
                    : 'border-[color:var(--color-border)]'
                }`}
              >
                <div className="flex-1">
                  <p className="text-sm font-medium">{row.title}</p>
                  {row.note && (
                    <p className="mt-1 text-xs text-[color:var(--color-muted-foreground)]">
                      {row.note}
                    </p>
                  )}
                  <p className="mt-1 text-xs text-[color:var(--color-muted-foreground)]">
                    Due{' '}
                    <time dateTime={row.dueAt.toISOString()}>
                      {row.dueAt.toLocaleString()}
                    </time>
                    {overdue && (
                      <span className="ml-2 rounded-full bg-red-100 px-2 py-0.5 font-medium text-red-900">
                        overdue
                      </span>
                    )}
                    {row.assignedTo && (
                      <> · assigned to {row.assignedTo}</>
                    )}
                  </p>
                </div>
                <form action={completeFollowUpAction}>
                  <input type="hidden" name="id" value={row.id} />
                  <button
                    type="submit"
                    className="rounded-[var(--radius-md)] border border-[color:var(--color-border)] px-3 py-1 text-xs font-medium hover:border-[color:var(--color-foreground)]"
                  >
                    Mark done
                  </button>
                </form>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
