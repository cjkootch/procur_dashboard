import Link from 'next/link';
import {
  getThreadDetail,
  listInboxThreads,
  type ThreadListRow,
  type ThreadMessageRow,
} from '@procur/catalog';
import { draftReplyAction } from './actions';

/**
 * Outlook-style two-pane inbox shell. Reused by /inbox (no thread
 * selected → empty-state right pane) and /inbox/[threadId] (right
 * pane shows the selected thread).
 *
 * Design borrowed from shadcn/ui's `mail` example pattern (MIT-
 * licensed reference): CSS-grid with a sidebar list + main pane,
 * highlight active row, accordion messages with collapse/expand.
 *
 * Server-rendered end-to-end. URL drives selection — no client
 * state for which thread is active. Messages within a thread are
 * client-side toggleable; that's a future client component.
 */

interface InboxShellProps {
  activeThreadId: string | null;
}

export async function InboxShell({ activeThreadId }: InboxShellProps) {
  const threads = await listInboxThreads({ limit: 100 });
  const detail = activeThreadId ? await getThreadDetail(activeThreadId) : null;

  return (
    <div className="grid h-[calc(100vh-var(--shell-topbar-height)-1px)] grid-cols-1 lg:grid-cols-[360px_1fr]">
      <ThreadList threads={threads} activeThreadId={activeThreadId} />

      <main className="overflow-y-auto bg-[color:var(--color-background)]">
        {detail ? (
          <ThreadDetail
            threadId={detail.thread.id}
            channel={detail.thread.channel}
            subject={detail.thread.subject}
            messages={detail.messages}
          />
        ) : activeThreadId ? (
          <EmptyState>
            Thread{' '}
            <span className="font-mono">{activeThreadId.slice(0, 12)}…</span>{' '}
            not found.{' '}
            <Link href="/inbox" className="underline">
              Back to inbox
            </Link>
            .
          </EmptyState>
        ) : (
          <EmptyState>
            Select a conversation from the list. Inbound emails landing via
            the Resend webhook (
            <span className="font-mono">/api/webhooks/resend-inbound</span>)
            appear on the left automatically. Reply drafts route through
            /approvals before any send goes out.
          </EmptyState>
        )}
      </main>
    </div>
  );
}

// ----------------------------------------------------------------------------
// Left pane — thread list
// ----------------------------------------------------------------------------

function ThreadList({
  threads,
  activeThreadId,
}: {
  threads: ThreadListRow[];
  activeThreadId: string | null;
}) {
  return (
    <aside className="hidden flex-col border-r border-[color:var(--color-border)] lg:flex">
      <header className="flex items-center justify-between border-b border-[color:var(--color-border)] px-4 py-3">
        <div>
          <h1 className="text-base font-semibold tracking-tight">Inbox</h1>
          <p className="text-[10px] uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
            {threads.length} thread{threads.length === 1 ? '' : 's'}
          </p>
        </div>
        <Link
          href="/messages"
          className="text-xs text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-foreground)]"
          title="SMS + WhatsApp threads"
        >
          Messages →
        </Link>
      </header>
      <div className="flex-1 overflow-y-auto">
        {threads.length === 0 ? (
          <div className="p-6 text-center text-xs text-[color:var(--color-muted-foreground)]">
            No threads yet.
          </div>
        ) : (
          <ul className="divide-y divide-[color:var(--color-border)]">
            {threads.map((t) => {
              const active = t.id === activeThreadId;
              return (
                <li key={t.id}>
                  <Link
                    href={`/inbox/${t.id}`}
                    className={`block px-4 py-3 transition ${
                      active
                        ? 'bg-[color:var(--color-muted)]/60'
                        : 'hover:bg-[color:var(--color-muted)]/30'
                    }`}
                  >
                    <div className="flex items-baseline gap-2">
                      <span className="truncate text-sm font-medium">
                        {t.lastFromEmail ?? 'unknown sender'}
                      </span>
                      {t.lastMessageAt && (
                        <time
                          className="ml-auto shrink-0 text-[10px] text-[color:var(--color-muted-foreground)]"
                          dateTime={t.lastMessageAt.toISOString()}
                        >
                          {formatRelative(t.lastMessageAt)}
                        </time>
                      )}
                    </div>
                    <p className="mt-0.5 truncate text-sm">
                      {t.subject ?? '(no subject)'}
                    </p>
                    <p className="mt-0.5 truncate text-xs text-[color:var(--color-muted-foreground)]">
                      <span className="rounded-sm bg-[color:var(--color-muted)]/60 px-1 text-[10px] font-mono">
                        {t.channel}
                      </span>{' '}
                      {t.messageCount} message{t.messageCount === 1 ? '' : 's'}
                    </p>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </aside>
  );
}

// ----------------------------------------------------------------------------
// Right pane — thread detail (accordion of messages)
// ----------------------------------------------------------------------------

function ThreadDetail({
  threadId,
  channel,
  subject,
  messages,
}: {
  threadId: string;
  channel: string;
  subject: string | null;
  messages: ThreadMessageRow[];
}) {
  const lastInbound = [...messages].reverse().find((m) => m.direction === 'inbound');
  const participantSet = new Set<string>();
  for (const m of messages) {
    if (m.fromEmail) participantSet.add(m.fromEmail);
  }
  const participants = Array.from(participantSet).slice(0, 5);

  return (
    <div className="mx-auto max-w-3xl px-6 py-6 lg:px-10 lg:py-8">
      <header className="mb-6 border-b border-[color:var(--color-border)] pb-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-full bg-[color:var(--color-muted)]/60 px-2 py-0.5 text-[10px] font-mono uppercase">
            {channel}
          </span>
          <h1 className="flex-1 text-xl font-semibold tracking-tight">
            {subject ?? '(no subject)'}
          </h1>
          <Link
            href="/inbox"
            className="text-xs text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-foreground)] lg:hidden"
          >
            ← Back
          </Link>
        </div>
        {participants.length > 0 && (
          <p className="mt-1 text-xs text-[color:var(--color-muted-foreground)]">
            {participants.join(' · ')}
          </p>
        )}
        <p className="mt-1 text-[10px] uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
          {messages.length} message{messages.length === 1 ? '' : 's'}
        </p>
      </header>

      <div className="space-y-3">
        {messages.map((m, i) => (
          <MessageCard
            key={m.id}
            message={m}
            // Latest message expanded by default; older ones collapsed.
            // <details> handles toggle natively — no client component needed.
            defaultOpen={i === messages.length - 1}
          />
        ))}
      </div>

      {lastInbound && (
        <form
          action={draftReplyAction}
          className="mt-6 flex items-center gap-3 rounded-[var(--radius-md)] border border-dashed border-[color:var(--color-border)] p-4"
        >
          <input type="hidden" name="messageId" value={lastInbound.id} />
          <input type="hidden" name="threadId" value={threadId} />
          <button
            type="submit"
            className="rounded-[var(--radius-md)] bg-[color:var(--color-foreground)] px-4 py-2 text-sm font-medium text-[color:var(--color-background)]"
          >
            Draft reply
          </button>
          <p className="text-xs text-[color:var(--color-muted-foreground)]">
            EmailReplyDraftAgent → /approvals → Resend dispatch.
          </p>
        </form>
      )}
    </div>
  );
}

function MessageCard({
  message,
  defaultOpen,
}: {
  message: ThreadMessageRow;
  defaultOpen: boolean;
}) {
  const directionTone =
    message.direction === 'inbound'
      ? 'bg-[color:var(--color-background)]'
      : 'bg-[color:var(--color-muted)]/20';
  return (
    <details
      open={defaultOpen}
      className={`rounded-[var(--radius-lg)] border border-[color:var(--color-border)] ${directionTone}`}
    >
      <summary className="cursor-pointer list-none px-4 py-3">
        <div className="flex items-baseline gap-2">
          <span className="rounded-full bg-[color:var(--color-muted)]/60 px-2 py-0.5 text-[10px] font-mono uppercase">
            {message.direction}
          </span>
          <span className="text-sm font-medium">
            {message.fromEmail ?? '(unknown)'}
          </span>
          <time
            className="ml-auto text-xs text-[color:var(--color-muted-foreground)]"
            dateTime={message.createdAt.toISOString()}
          >
            {message.createdAt.toLocaleString()}
          </time>
        </div>
        {message.subject && (
          <p className="mt-1 text-sm">{message.subject}</p>
        )}
        {!defaultOpen && message.bodyText && (
          <p className="mt-1 truncate text-xs text-[color:var(--color-muted-foreground)]">
            {message.bodyText.slice(0, 200)}
          </p>
        )}
      </summary>
      <div className="border-t border-[color:var(--color-border)] px-4 py-4">
        {message.bodyText ? (
          <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-relaxed">
            {message.bodyText}
          </pre>
        ) : (
          <p className="text-sm italic text-[color:var(--color-muted-foreground)]">
            (no plain-text body)
          </p>
        )}
      </div>
    </details>
  );
}

// ----------------------------------------------------------------------------
// Empty state
// ----------------------------------------------------------------------------

function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center px-8">
      <div className="max-w-md text-center text-sm text-[color:var(--color-muted-foreground)]">
        {children}
      </div>
    </div>
  );
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

/**
 * Compact relative timestamp for the thread list — "3:42 PM" today,
 * "Mon" this week, otherwise "May 02". Mirrors the shadcn mail example.
 */
function formatRelative(d: Date): string {
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) {
    return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }
  const weekAgo = new Date(now.getTime() - 7 * 24 * 3600 * 1000);
  if (d >= weekAgo) {
    return d.toLocaleDateString([], { weekday: 'short' });
  }
  return d.toLocaleDateString([], { month: 'short', day: '2-digit' });
}
