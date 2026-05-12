import { requireCompany } from '@procur/auth';
import { Chat } from '../../components/assistant/Chat';
import { ConversationsAside } from '../../components/assistant/ConversationsAside';
import { listThreads } from '../../lib/assistant/threads';

export const dynamic = 'force-dynamic';

export default async function AssistantHomePage() {
  const { user, company } = await requireCompany();
  const threads = await listThreads(company.id, user.id);

  // dvh (dynamic viewport height) rather than vh — iOS Safari's vh
  // measures the LAYOUT viewport so the chat composer ends up behind
  // the keyboard when it opens. dvh tracks the visible viewport. Same
  // applies on /assistant/[threadId].
  return (
    <div className="flex h-[calc(100dvh-var(--shell-topbar-height)-1px)] flex-col lg:flex-row">
      <ConversationsAside
        threads={threads.map((t) => ({
          id: t.id,
          title: t.title,
          lastMessageAtIso: t.lastMessageAt.toISOString(),
        }))}
      />
      <div className="flex min-h-0 flex-1 flex-col">
        <header className="border-b border-[color:var(--color-border)] px-4 py-3 md:px-6">
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
