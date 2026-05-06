import Link from 'next/link';
import { requireCompany } from '@procur/auth';
import { listSignals } from '@procur/catalog';
import { acknowledgeSignalAction } from './actions';

export const dynamic = 'force-dynamic';

const SEVERITY_TONE: Record<string, string> = {
  critical: 'bg-red-100 text-red-900',
  warn: 'bg-yellow-100 text-yellow-900',
  info: 'bg-[color:var(--color-muted)]/60',
};

/**
 * Signals inbox per docs/vex-into-procur-merge-brief.md Phase 6.
 * Agents fire signals directly (sanctions matches, deal warnings,
 * stale follow-ups). Acknowledged rows persist for audit.
 */
export default async function SignalsPage() {
  await requireCompany();
  const rows = await listSignals({ onlyUnacknowledged: true, limit: 100 });

  return (
    <div className="mx-auto max-w-3xl px-8 py-10">
      <header className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Signals</h1>
          <p className="mt-1 text-sm text-[color:var(--color-muted-foreground)]">
            Unacknowledged proactive signals. Fired by sanctions screening,
            deal evaluation, follow-up cron, and other agents.
          </p>
        </div>
        <Link
          href="/brief"
          className="text-sm text-[color:var(--color-muted-foreground)] underline hover:text-[color:var(--color-foreground)]"
        >
          Daily brief →
        </Link>
      </header>

      {rows.length === 0 ? (
        <div className="rounded-[var(--radius-lg)] border border-dashed border-[color:var(--color-border)] p-10 text-center text-sm text-[color:var(--color-muted-foreground)]">
          No unacknowledged signals.
        </div>
      ) : (
        <ul className="space-y-2">
          {rows.map((row) => (
            <li
              key={row.id}
              className="flex items-start gap-3 rounded-[var(--radius-lg)] border border-[color:var(--color-border)] p-4"
            >
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-medium ${SEVERITY_TONE[row.severity] ?? ''}`}
                  >
                    {row.severity}
                  </span>
                  <span className="font-mono text-xs text-[color:var(--color-muted-foreground)]">
                    {row.ruleId}
                  </span>
                  <time
                    className="ml-auto text-xs text-[color:var(--color-muted-foreground)]"
                    dateTime={row.createdAt.toISOString()}
                  >
                    {row.createdAt.toLocaleString()}
                  </time>
                </div>
                <p className="mt-1 text-sm font-medium">{row.title}</p>
                {row.body && (
                  <p className="mt-0.5 text-xs text-[color:var(--color-muted-foreground)]">
                    {row.body}
                  </p>
                )}
                {row.subjectType && row.subjectId && (
                  <p className="mt-1 text-xs">
                    <span className="text-[color:var(--color-muted-foreground)]">
                      Subject:
                    </span>{' '}
                    <span className="font-mono">
                      {row.subjectType} / {row.subjectId.slice(0, 12)}
                    </span>
                  </p>
                )}
              </div>
              <form action={acknowledgeSignalAction}>
                <input type="hidden" name="id" value={row.id} />
                <button
                  type="submit"
                  className="rounded-[var(--radius-md)] border border-[color:var(--color-border)] px-3 py-1 text-xs font-medium hover:border-[color:var(--color-foreground)]"
                >
                  Acknowledge
                </button>
              </form>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
