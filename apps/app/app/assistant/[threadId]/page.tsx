import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireCompany } from '@procur/auth';
import type {
  AnthropicContentBlock,
  AnthropicTextBlockParam,
  AnthropicToolResultBlockParam,
} from '@procur/ai';
import { Chat } from '../../../components/assistant/Chat';
import { ThreadListItem } from '../../../components/assistant/ThreadListItem';
import type {
  PageContextInput,
  RenderedMessage,
  RenderedToolUse,
} from '../../../components/assistant/types';
import {
  getThread,
  listMessages,
  listThreads,
} from '../../../lib/assistant/threads';
import { formatDate } from '../../../lib/format';
import type { AssistantMessage } from '@procur/db';

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

/**
 * Convert persisted messages into the RenderedMessage shape the Chat
 * component displays. Tool rows are merged into the preceding assistant
 * message so the UI sees a single message with its tool_use + result pair.
 */
function hydrateMessages(rows: AssistantMessage[]): RenderedMessage[] {
  const out: RenderedMessage[] = [];
  for (const m of rows) {
    if (m.role === 'user') {
      const blocks = m.content as AnthropicTextBlockParam[];
      const text = blocks.map((b) => ('text' in b ? b.text : '')).join('');
      out.push({ id: m.id, kind: 'user', text });
    } else if (m.role === 'assistant') {
      const content = m.content as AnthropicContentBlock[];
      let text = '';
      const toolUses: RenderedToolUse[] = [];
      for (const b of content) {
        if (b.type === 'text') text += b.text;
        else if (b.type === 'tool_use') {
          toolUses.push({ id: b.id, name: b.name, input: b.input });
        }
      }
      out.push({ id: m.id, kind: 'assistant', text, toolUses, streaming: false });
    } else if (m.role === 'tool') {
      const blocks = m.content as AnthropicToolResultBlockParam[];
      const last = out[out.length - 1];
      if (last && last.kind === 'assistant') {
        for (const r of blocks) {
          const existing = last.toolUses.find((t) => t.id === r.tool_use_id);
          const output = parseToolResultContent(r.content);
          if (existing) {
            existing.result = { output, isError: r.is_error ?? false };
          } else {
            last.toolUses.push({
              id: r.tool_use_id,
              name: 'tool',
              input: null,
              result: { output, isError: r.is_error ?? false },
            });
          }
        }
      }
    }
  }
  return out;
}

function parseToolResultContent(
  content: AnthropicToolResultBlockParam['content'],
): unknown {
  if (typeof content === 'string') {
    try {
      return JSON.parse(content);
    } catch {
      return content;
    }
  }
  return content;
}
