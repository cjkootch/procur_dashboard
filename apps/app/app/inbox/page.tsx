import Link from 'next/link';
import { requireCompany } from '@procur/auth';
import { listInboxThreads } from '@procur/catalog';

export const dynamic = 'force-dynamic';

/**
 * Inbox per docs/vex-into-procur-merge-brief.md Phase 3. Lists threads
 * sorted by `last_message_at`, most recent first. Procur ships thread-
 * grouped (vs vex's flat timeline) because Phase 1 schema has explicit
 * thread rows.
 */
export default async function InboxPage() {
  await requireCompany();
  const threads = await listInboxThreads({ limit: 100 });

  return (
    <div className="mx-auto max-w-5xl px-8 py-10">
      <header className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Inbox</h1>
          <p className="mt-1 text-sm text-[color:var(--color-muted-foreground)]">
            Inbound + outbound messages grouped by thread. Reply drafts route
            through the approval queue before any send goes out.
          </p>
        </div>
        <Link
          href="/approvals"
          className="text-sm text-[color:var(--color-muted-foreground)] underline hover:text-[color:var(--color-foreground)]"
        >
          Approvals →
        </Link>
      </header>

      {threads.length === 0 ? (
        <div className="rounded-[var(--radius-lg)] border border-dashed border-[color:var(--color-border)] p-10 text-center text-sm text-[color:var(--color-muted-foreground)]">
          No threads yet. Inbound emails received via the Resend webhook
          (/api/webhooks/resend-inbound) will appear here.
        </div>
      ) : (
        <div className="space-y-2">
          {threads.map((t) => (
            <Link
              key={t.id}
              href={`/inbox/${t.id}`}
              className="flex items-start gap-4 rounded-[var(--radius-lg)] border border-[color:var(--color-border)] p-4 transition hover:border-[color:var(--color-foreground)]"
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="rounded-full bg-[color:var(--color-muted)]/60 px-2 py-0.5 text-xs font-medium">
                    {t.channel}
                  </span>
                  <span className="truncate text-sm font-medium">
                    {t.subject ?? '(no subject)'}
                  </span>
                </div>
                <p className="mt-1 truncate text-xs text-[color:var(--color-muted-foreground)]">
                  {t.lastFromEmail ?? 'unknown sender'} ·{' '}
                  {t.messageCount} message{t.messageCount === 1 ? '' : 's'}
                </p>
              </div>
              {t.lastMessageAt && (
                <time
                  className="shrink-0 text-xs text-[color:var(--color-muted-foreground)]"
                  dateTime={t.lastMessageAt.toISOString()}
                >
                  {t.lastMessageAt.toLocaleString()}
                </time>
              )}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
