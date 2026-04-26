import Link from 'next/link';
import { requireCompany } from '@procur/auth';
import { Chat } from '../../components/assistant/Chat';
import { ThreadListItem } from '../../components/assistant/ThreadListItem';
import { listThreads } from '../../lib/assistant/threads';

export const dynamic = 'force-dynamic';

export default async function AssistantHomePage() {
  const { user, company } = await requireCompany();
  const threads = await listThreads(company.id, user.id);

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
        {threads.length === 0 ? (
          <p className="text-xs text-[color:var(--color-muted-foreground)]">
            No conversations yet. Ask a question to start one.
          </p>
        ) : (
          <ul className="flex flex-col gap-1">
            {threads.map((t) => (
              <ThreadListItem
                key={t.id}
                id={t.id}
                title={t.title}
                lastMessageAtIso={t.lastMessageAt.toISOString()}
                active={false}
              />
            ))}
          </ul>
        )}
      </aside>
      <div className="flex flex-1 flex-col">
        <header className="border-b border-[color:var(--color-border)] px-6 py-3">
          <h1 className="text-lg font-semibold tracking-tight">Procur Assistant</h1>
          <p className="text-xs text-[color:var(--color-muted-foreground)]">
            Ask about your pipeline, search tenders, draft sections.
          </p>
        </header>
        <div className="flex-1 overflow-hidden">
          <Chat autoFocus placeholder="Ask anything about your pipeline…" />
        </div>
      </div>
    </div>
  );
}
