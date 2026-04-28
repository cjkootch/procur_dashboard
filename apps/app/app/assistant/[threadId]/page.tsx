import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireCompany } from '@procur/auth';
import { Chat } from '../../../components/assistant/Chat';
import { ThreadListItem } from '../../../components/assistant/ThreadListItem';
import type { PageContextInput } from '../../../components/assistant/types';
import { hydrateMessages } from '../../../lib/assistant/hydrate';
import {
  getThread,
  listMessages,
  listThreads,
} from '../../../lib/assistant/threads';
import { formatDate } from '../../../lib/format';

export const dynamic = 'force-dynamic';

type Props = {
  params: Promise<{ threadId: string }>;
  searchParams: Promise<{ ctx?: string; id?: string }>;
};

export default async function AssistantThreadPage({ params, searchParams }: Props) {
  const { threadId } = await params;
  const { ctx: ctxKind, id: ctxId } = await searchParams;
  const { user, company } = await requireCompany();
  const thread = await getThread(company.id, user.id, threadId);
  if (!thread) notFound();

  const [rawMessages, threads] = await Promise.all([
    listMessages(threadId),
    listThreads(company.id, user.id),
  ]);

  const rendered = hydrateMessages(rawMessages);
  const pageContext = parsePageContext(ctxKind, ctxId);

  return (
    <div className="flex h-[calc(100vh-0px)]">
      <aside className="w-64 shrink-0 overflow-y-auto border-r border-[color:var(--color-border)] bg-[color:var(--color-muted)]/20 p-3">
        <Link
          href="/"
          className="mb-3 inline-flex items-center gap-1 text-xs text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-foreground)]"
        >
          ← Back to app
        </Link>
        <div className="mb-3 flex items-center justify-between">
          <div className="text-sm font-medium">Conversations</div>
          <Link
            href="/assistant"
            className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] px-2 py-0.5 text-xs"
          >
            New
          </Link>
        </div>
        <ul className="flex flex-col gap-1">
          {threads.map((t) => (
            <ThreadListItem
              key={t.id}
              id={t.id}
              title={t.title}
              lastMessageAtIso={t.lastMessageAt.toISOString()}
              active={t.id === threadId}
            />
          ))}
        </ul>
      </aside>
      <div className="flex flex-1 flex-col">
        <header className="border-b border-[color:var(--color-border)] px-6 py-3">
          <h1 className="text-lg font-semibold tracking-tight">{thread.title}</h1>
          <p className="text-xs text-[color:var(--color-muted-foreground)]">
            Started {formatDate(thread.createdAt)}
          </p>
        </header>
        <div className="flex-1 overflow-hidden">
          <Chat
            initialThreadId={threadId}
            initialMessages={rendered}
            pageContext={pageContext}
            autoFocus
          />
        </div>
      </div>
    </div>
  );
}

function parsePageContext(kind?: string, id?: string): PageContextInput | undefined {
  if (!kind || !id) return undefined;
  if (kind === 'pursuit' || kind === 'proposal' || kind === 'opportunity' || kind === 'contract') {
    return { kind, id };
  }
  return undefined;
}

