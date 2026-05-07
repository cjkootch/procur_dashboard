import Link from 'next/link';
import {
  getMessagingConversation,
  listMessagingConversations,
  type MessagingConversation,
  type MessagingMessage,
} from '@procur/catalog';

/**
 * Outlook-style two-pane shell for SMS + WhatsApp conversations.
 * Reused by /messages (no conversation selected → empty-state right
 * pane) and /messages/[phone] (right pane shows the bubble view).
 *
 * The list pane mirrors /inbox's design pattern (compact rows,
 * highlight active). The right pane uses phone-text bubble layout —
 * outbound right-aligned with foreground bg, inbound left-aligned
 * with muted bg. Date separators between days. All server-rendered;
 * URL drives selection.
 *
 * Phone is the natural conversation key (no thread row exists for
 * SMS/WhatsApp), so URLs encode the E.164 number with the leading
 * `+` URL-encoded as `%2B`.
 */

interface MessagesShellProps {
  activePhone: string | null;
}

export async function MessagesShell({ activePhone }: MessagesShellProps) {
  let conversations: MessagingConversation[] = [];
  let detail: Awaited<ReturnType<typeof getMessagingConversation>> = null;
  let loadError: string | null = null;
  try {
    conversations = await listMessagingConversations({ limit: 100 });
    detail = activePhone ? await getMessagingConversation(activePhone) : null;
  } catch (err) {
    // Surface the real message on /messages instead of crashing into
    // Next's generic error boundary — Cole hit a 500 here and the
    // reference id alone isn't enough to debug.
    loadError = err instanceof Error ? err.message : String(err);
    console.error('[messages] load failed', err);
  }

  if (loadError) {
    return (
      <div className="p-6">
        <div className="max-w-2xl rounded-[var(--radius-md)] border border-[color:var(--color-destructive)]/40 bg-[color:var(--color-destructive)]/5 px-4 py-3 text-sm">
          <p className="font-medium text-[color:var(--color-destructive)]">
            Couldn&rsquo;t load conversations.
          </p>
          <p className="mt-1 text-[color:var(--color-muted-foreground)]">
            <span className="font-mono text-xs">{loadError}</span>
          </p>
        </div>
      </div>
    );
  }

  // Mobile two-pane: when a conversation is selected, hide the list
  // and show only the detail (with a back button); when nothing
  // selected, show only the list. Desktop (lg+) shows both side-by-
  // side regardless.
  const showListOnMobile = !activePhone;
  const showDetailOnMobile = !!activePhone;

  return (
    <div className="grid h-[calc(100vh-var(--shell-topbar-height)-1px)] grid-cols-1 lg:grid-cols-[360px_1fr]">
      <ConversationList
        conversations={conversations}
        activePhone={activePhone}
        mobileVisible={showListOnMobile}
      />

      <main
        className={`flex-col overflow-hidden bg-[color:var(--color-background)] lg:flex ${
          showDetailOnMobile ? 'flex' : 'hidden'
        }`}
      >
        {detail ? (
          <ConversationDetail
            phone={detail.phone}
            contactId={detail.contactId}
            contactName={detail.contactName}
            messages={detail.messages}
          />
        ) : activePhone ? (
          <EmptyState>
            No messages on file with{' '}
            <span className="font-mono">{activePhone}</span> yet.{' '}
            <Link href="/messages" className="underline">
              Back to messages
            </Link>
            .
          </EmptyState>
        ) : (
          <EmptyState>
            Select a conversation. SMS + WhatsApp messages from the Twilio
            inbound webhook (
            <span className="font-mono">/api/webhooks/twilio</span>) appear on
            the left automatically. Outbound sends route through /approvals
            before they dispatch.
          </EmptyState>
        )}
      </main>
    </div>
  );
}

// ----------------------------------------------------------------------------
// Left pane
// ----------------------------------------------------------------------------

const CHANNEL_TONE: Record<string, string> = {
  sms: 'bg-blue-100 text-blue-900',
  whatsapp: 'bg-green-100 text-green-900',
  mixed: 'bg-[color:var(--color-muted)]/60',
};

function ConversationList({
  conversations,
  activePhone,
  mobileVisible,
}: {
  conversations: MessagingConversation[];
  activePhone: string | null;
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
          <h1 className="text-base font-semibold tracking-tight">Messages</h1>
          <p className="text-[10px] uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
            {conversations.length} conversation
            {conversations.length === 1 ? '' : 's'}
          </p>
        </div>
        <Link
          href="/inbox"
          className="text-xs text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-foreground)]"
          title="Email threads"
        >
          Inbox →
        </Link>
      </header>
      <div className="flex-1 overflow-y-auto">
        {conversations.length === 0 ? (
          <div className="p-6 text-center text-xs text-[color:var(--color-muted-foreground)]">
            No SMS / WhatsApp activity in the last 90 days.
          </div>
        ) : (
          <ul className="divide-y divide-[color:var(--color-border)]">
            {conversations.map((c) => {
              const active = c.phone === activePhone;
              return (
                <li key={c.phone}>
                  <Link
                    href={`/messages/${encodeURIComponent(c.phone)}`}
                    className={`block px-4 py-3 transition ${
                      active
                        ? 'bg-[color:var(--color-muted)]/60'
                        : 'hover:bg-[color:var(--color-muted)]/30'
                    }`}
                  >
                    <div className="flex items-baseline gap-2">
                      <span className="truncate text-sm font-medium">
                        {c.contactName ?? c.phone}
                      </span>
                      <time
                        className="ml-auto shrink-0 text-[10px] text-[color:var(--color-muted-foreground)]"
                        dateTime={c.lastMessageAt.toISOString()}
                      >
                        {formatRelative(c.lastMessageAt)}
                      </time>
                    </div>
                    {c.contactName && (
                      <p className="mt-0.5 truncate font-mono text-[10px] text-[color:var(--color-muted-foreground)]">
                        {c.phone}
                      </p>
                    )}
                    <p className="mt-0.5 truncate text-xs">
                      {c.lastDirection === 'outbound' && (
                        <span className="text-[color:var(--color-muted-foreground)]">
                          You:{' '}
                        </span>
                      )}
                      {c.lastMessagePreview ?? '(no preview)'}
                    </p>
                    <p className="mt-1 flex items-center gap-1 text-[10px]">
                      <span
                        className={`rounded-sm px-1 font-mono ${CHANNEL_TONE[c.channel] ?? ''}`}
                      >
                        {c.channel}
                      </span>
                      <span className="text-[color:var(--color-muted-foreground)]">
                        {c.totalMessages} msg
                        {c.totalMessages === 1 ? '' : 's'}
                      </span>
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
// Right pane — phone-text bubble view
// ----------------------------------------------------------------------------

function ConversationDetail({
  phone,
  contactId,
  contactName,
  messages,
}: {
  phone: string;
  contactId: string | null;
  contactName: string | null;
  messages: MessagingMessage[];
}) {
  // Group by local date so we can render "May 02" separators between
  // days. Same convention as iMessage / WhatsApp / Signal.
  const grouped = groupByLocalDate(messages);

  return (
    <>
      <header className="flex items-baseline gap-2 border-b border-[color:var(--color-border)] px-6 py-4">
        <Link
          href="/messages"
          className="mr-1 text-xs text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-foreground)] lg:hidden"
        >
          ←
        </Link>
        <h1 className="text-lg font-semibold">
          {contactName ? (
            <>
              {contactId ? (
                <Link href={`/contacts/${contactId}`} className="underline">
                  {contactName}
                </Link>
              ) : (
                contactName
              )}{' '}
              <span className="text-xs font-normal text-[color:var(--color-muted-foreground)]">
                · {phone}
              </span>
            </>
          ) : (
            <span className="font-mono">{phone}</span>
          )}
        </h1>
        <span className="ml-auto text-[10px] uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
          {messages.length} message{messages.length === 1 ? '' : 's'}
        </span>
      </header>

      <div className="flex-1 overflow-y-auto px-4 py-6 lg:px-8">
        <div className="mx-auto flex max-w-2xl flex-col gap-2">
          {grouped.map((group) => (
            <div key={group.label} className="flex flex-col gap-2">
              <div className="my-2 flex items-center gap-3 text-[10px] uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
                <span className="h-px flex-1 bg-[color:var(--color-border)]" />
                <span>{group.label}</span>
                <span className="h-px flex-1 bg-[color:var(--color-border)]" />
              </div>
              {group.messages.map((m) => (
                <Bubble key={m.id} message={m} />
              ))}
            </div>
          ))}
        </div>
      </div>

      <footer className="border-t border-[color:var(--color-border)] px-6 py-3 text-xs text-[color:var(--color-muted-foreground)]">
        To reply, ask the chat assistant — outbound SMS / WhatsApp routes
        through /approvals before dispatch.
      </footer>
    </>
  );
}

function Bubble({ message }: { message: MessagingMessage }) {
  const isOutbound = message.direction === 'outbound';
  const channelHint =
    message.channel === 'whatsapp' ? 'WhatsApp' : 'SMS';
  return (
    <div
      className={`flex flex-col gap-0.5 ${
        isOutbound ? 'items-end' : 'items-start'
      }`}
    >
      <div
        className={`max-w-[78%] rounded-2xl px-4 py-2 text-sm ${
          isOutbound
            ? 'rounded-br-sm bg-[color:var(--color-foreground)] text-[color:var(--color-background)]'
            : 'rounded-bl-sm bg-[color:var(--color-muted)]/70'
        }`}
      >
        {message.body ? (
          <p className="whitespace-pre-wrap break-words">{message.body}</p>
        ) : (
          <p className="italic opacity-70">(no body)</p>
        )}
      </div>
      <p className="px-1 text-[10px] text-[color:var(--color-muted-foreground)]">
        <time dateTime={message.occurredAt.toISOString()}>
          {message.occurredAt.toLocaleTimeString([], {
            hour: 'numeric',
            minute: '2-digit',
          })}
        </time>
        {' · '}
        {channelHint}
        {message.sourceApprovalId && (
          <>
            {' · '}
            <Link
              href={`/approvals/${message.sourceApprovalId}`}
              className="underline"
            >
              approval
            </Link>
          </>
        )}
      </p>
    </div>
  );
}

// ----------------------------------------------------------------------------
// Helpers
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

interface MessageGroup {
  label: string;
  messages: MessagingMessage[];
}

function groupByLocalDate(messages: MessagingMessage[]): MessageGroup[] {
  const groups: MessageGroup[] = [];
  let lastKey: string | null = null;
  for (const m of messages) {
    const key = m.occurredAt.toDateString();
    if (key !== lastKey) {
      groups.push({ label: formatDateSeparator(m.occurredAt), messages: [] });
      lastKey = key;
    }
    groups[groups.length - 1]!.messages.push(m);
  }
  return groups;
}

function formatDateSeparator(d: Date): string {
  const now = new Date();
  const today = now.toDateString();
  const yesterday = new Date(now.getTime() - 24 * 3600 * 1000).toDateString();
  if (d.toDateString() === today) return 'Today';
  if (d.toDateString() === yesterday) return 'Yesterday';
  const weekAgo = new Date(now.getTime() - 7 * 24 * 3600 * 1000);
  if (d >= weekAgo) {
    return d.toLocaleDateString([], { weekday: 'long' });
  }
  return d.toLocaleDateString([], {
    month: 'short',
    day: 'numeric',
    year: now.getFullYear() === d.getFullYear() ? undefined : 'numeric',
  });
}

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
