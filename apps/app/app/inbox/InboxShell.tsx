import Link from 'next/link';
import {
  getOrInitConversationSettings,
  getThreadDetail,
  listInboxThreads,
  type ThreadListRow,
  type ThreadMessageRow,
} from '@procur/catalog';
import { draftReplyAction } from './actions';
import { ConversationSettingsPanel } from '../../components/conversation/ConversationSettingsPanel';

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

  // Mobile two-pane: when a thread is selected, hide the list and
  // show only the detail (with a back button); when no thread is
  // selected, show only the list. Desktop (lg+) shows both side-by-
  // side regardless. The settings panel (third column on lg+)
  // renders only when a thread is selected.
  const showListOnMobile = !activeThreadId;
  const showDetailOnMobile = !!activeThreadId;

  const settings = activeThreadId
    ? await getOrInitConversationSettings({
        channel: 'email',
        conversationKey: activeThreadId,
      })
    : null;

  return (
    <div className="grid h-[calc(100vh-var(--shell-topbar-height)-1px)] grid-cols-1 lg:grid-cols-[360px_1fr_320px]">
      <ThreadList
        threads={threads}
        activeThreadId={activeThreadId}
        mobileVisible={showListOnMobile}
      />

      <main
        className={`overflow-y-auto bg-[color:var(--color-background)] ${
          showDetailOnMobile ? 'block' : 'hidden lg:block'
        }`}
      >
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

      {settings && activeThreadId && (
        <ConversationSettingsPanel
          initialSettings={settings}
          channel="email"
          conversationKey={activeThreadId}
        />
      )}
    </div>
  );
}

// ----------------------------------------------------------------------------
// Left pane — thread list
// ----------------------------------------------------------------------------

function ThreadList({
  threads,
  activeThreadId,
  mobileVisible,
}: {
  threads: ThreadListRow[];
  activeThreadId: string | null;
  mobileVisible: boolean;
}) {
  return (
    <aside
      className={`flex-col border-r border-[color:var(--color-border)] lg:flex ${
        mobileVisible ? 'flex' : 'hidden'
      }`}
    >
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
  const isInbound = message.direction === 'inbound';
  // Inbound = "them"  → left side, neutral surface, blue accent strip.
  // Outbound = "us"   → right side, tinted surface, emerald accent strip.
  // Mimics the conversation framing of /messages without going to full
  // SMS-style bubbles (email bodies are too long to right-align well).
  const directionStyle = isInbound
    ? 'border-l-[3px] border-l-blue-400 bg-[color:var(--color-background)] mr-0 lg:mr-12'
    : 'border-l-[3px] border-l-emerald-400 bg-[color:var(--color-muted)]/20 ml-0 lg:ml-12';

  // Split out quoted reply context (lines starting with "From:" /
  // "On … wrote:" + everything after) so the signal-to-noise of a
  // long thread stays high. Operator can expand to see the original.
  const split = message.bodyText ? splitQuotedReply(message.bodyText) : null;

  return (
    <details
      open={defaultOpen}
      className={`overflow-hidden rounded-[var(--radius-lg)] border border-[color:var(--color-border)] ${directionStyle}`}
    >
      <summary className="cursor-pointer list-none px-4 py-3">
        <div className="flex items-baseline gap-2">
          <span
            className={`rounded-full px-2 py-0.5 text-[10px] font-mono uppercase ${
              isInbound
                ? 'bg-blue-100 text-blue-900'
                : 'bg-emerald-100 text-emerald-900'
            }`}
          >
            {isInbound ? '↓ inbound' : '↑ outbound'}
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
        {split && split.body ? (
          <>
            <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-relaxed">
              {split.body}
            </pre>
            {split.quoted && (
              <details className="mt-3 text-xs">
                <summary className="cursor-pointer text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-foreground)]">
                  Show quoted history
                </summary>
                <pre className="mt-2 whitespace-pre-wrap break-words border-l-2 border-[color:var(--color-border)] pl-3 font-sans text-[color:var(--color-muted-foreground)]">
                  {split.quoted}
                </pre>
              </details>
            )}
          </>
        ) : message.bodyHtml ? (
          // Multipart/related emails (signature image inline) often
          // ship the webhook payload with HTML only, no plain-text
          // alternative. Strip-tag to text so the body still reads —
          // good enough for triage. Full-fidelity HTML render +
          // inline-attachment resolution is a future iteration.
          <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-relaxed">
            {htmlToPlainText(message.bodyHtml)}
          </pre>
        ) : (
          <p className="text-sm italic text-[color:var(--color-muted-foreground)]">
            (no body content)
          </p>
        )}
      </div>
    </details>
  );
}

/**
 * Split a plain-text email body into the reply portion and the
 * quoted-history portion. Quoted history typically starts with
 * `From: …` (Outlook/Gmail forward style) or `On <date> <name> wrote:`
 * (Gmail reply style). Returning the body alone when no quote
 * marker is found lets long single-author messages still render
 * cleanly.
 */
function splitQuotedReply(body: string): { body: string; quoted: string | null } {
  // Order matters — the more specific marker wins.
  const markers = [
    /\nFrom: .+(?:\n|$)/,
    /\nOn .+ wrote:.*?(?:\n|$)/,
    /\n-----Original Message-----.*?(?:\n|$)/i,
    /\n_{2,}.*?(?:\n|$)/, // long underscore separator some clients use
  ];
  for (const re of markers) {
    const match = body.match(re);
    if (match && match.index !== undefined) {
      const head = body.slice(0, match.index).trim();
      const tail = body.slice(match.index).trim();
      if (head.length > 0 && tail.length > 0) {
        return { body: head, quoted: tail };
      }
    }
  }
  return { body: body.trim(), quoted: null };
}

/**
 * Quick HTML → text fallback for inbound emails that arrived as HTML
 * only (no multipart text alternative). NOT a full HTML renderer —
 * just enough to surface the visible text so the operator can triage
 * a thread without bouncing to the original email.
 *
 * Strips: tags, style blocks, script blocks, common entities.
 * Preserves: line breaks at <br> and block-level boundaries.
 */
function htmlToPlainText(html: string): string {
  return html
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
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
