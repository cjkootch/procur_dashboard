import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireCompany } from '@procur/auth';
import { getThreadDetail } from '@procur/catalog';
import { draftReplyAction } from '../actions';

export const dynamic = 'force-dynamic';

interface PageProps {
  params: Promise<{ threadId: string }>;
}

/**
 * Thread detail per docs/vex-into-procur-merge-brief.md Phase 3.
 * Renders messages chronologically; "Draft reply" runs the
 * EmailReplyDraftAgent via AgentRunner — the agent's proposed
 * email.send lands in /approvals for review.
 */
export default async function ThreadDetailPage({ params }: PageProps) {
  await requireCompany();
  const { threadId } = await params;
  const detail = await getThreadDetail(threadId);
  if (!detail) notFound();

  const lastInbound = [...detail.messages]
    .reverse()
    .find((m) => m.direction === 'inbound');

  return (
    <div className="mx-auto max-w-3xl px-8 py-10">
      <Link
        href="/inbox"
        className="text-sm text-[color:var(--color-muted-foreground)] hover:underline"
      >
        ← Inbox
      </Link>

      <header className="mt-4 mb-6">
        <div className="flex items-center gap-2">
          <span className="rounded-full bg-[color:var(--color-muted)]/60 px-2 py-0.5 text-xs font-medium">
            {detail.thread.channel}
          </span>
          <h1 className="text-2xl font-semibold tracking-tight">
            {detail.thread.subject ?? '(no subject)'}
          </h1>
        </div>
        <p className="mt-1 text-xs text-[color:var(--color-muted-foreground)]">
          {detail.messages.length} message
          {detail.messages.length === 1 ? '' : 's'}
        </p>
      </header>

      <div className="space-y-4">
        {detail.messages.map((m) => (
          <article
            key={m.id}
            className={`rounded-[var(--radius-lg)] border p-4 ${
              m.direction === 'inbound'
                ? 'border-[color:var(--color-border)]'
                : 'border-[color:var(--color-border)] bg-[color:var(--color-muted)]/20'
            }`}
          >
            <header className="mb-2 flex items-center gap-2">
              <span className="rounded-full bg-[color:var(--color-muted)]/60 px-2 py-0.5 text-xs">
                {m.direction}
              </span>
              <span className="text-sm font-medium">
                {m.fromEmail ?? '(unknown)'}
              </span>
              <time
                className="ml-auto text-xs text-[color:var(--color-muted-foreground)]"
                dateTime={m.createdAt.toISOString()}
              >
                {m.createdAt.toLocaleString()}
              </time>
            </header>
            {m.subject && m.subject !== detail.thread.subject && (
              <p className="mb-2 text-sm font-medium">{m.subject}</p>
            )}
            {m.bodyText ? (
              <pre className="whitespace-pre-wrap break-words font-sans text-sm">
                {m.bodyText}
              </pre>
            ) : (
              <p className="text-sm italic text-[color:var(--color-muted-foreground)]">
                (no plain-text body)
              </p>
            )}
          </article>
        ))}
      </div>

      {lastInbound && (
        <form
          action={draftReplyAction}
          className="mt-6 flex items-center gap-3"
        >
          <input type="hidden" name="messageId" value={lastInbound.id} />
          <input type="hidden" name="threadId" value={detail.thread.id} />
          <button
            type="submit"
            className="rounded-[var(--radius-md)] bg-[color:var(--color-foreground)] px-4 py-2 text-sm font-medium text-[color:var(--color-background)]"
          >
            Draft reply
          </button>
          <p className="text-xs text-[color:var(--color-muted-foreground)]">
            Runs EmailReplyDraftAgent → routes the draft through
            /approvals → operator approves → Resend dispatches.
          </p>
        </form>
      )}
    </div>
  );
}
