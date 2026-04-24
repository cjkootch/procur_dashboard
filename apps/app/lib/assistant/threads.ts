import 'server-only';
import { and, desc, eq } from 'drizzle-orm';
import type {
  AnthropicContentBlock,
  AnthropicMessageParam,
  AnthropicTextBlockParam,
  AnthropicToolResultBlockParam,
} from '@procur/ai';
import {
  assistantMessages,
  assistantThreads,
  db,
  type AssistantMessage,
  type AssistantThread,
} from '@procur/db';

export type ThreadListRow = Pick<
  AssistantThread,
  'id' | 'title' | 'lastMessageAt' | 'createdAt'
>;

export async function listThreads(
  companyId: string,
  userId: string,
): Promise<ThreadListRow[]> {
  return db
    .select({
      id: assistantThreads.id,
      title: assistantThreads.title,
      lastMessageAt: assistantThreads.lastMessageAt,
      createdAt: assistantThreads.createdAt,
    })
    .from(assistantThreads)
    .where(
      and(eq(assistantThreads.companyId, companyId), eq(assistantThreads.userId, userId)),
    )
    .orderBy(desc(assistantThreads.lastMessageAt))
    .limit(50);
}

export async function getThread(
  companyId: string,
  userId: string,
  threadId: string,
): Promise<AssistantThread | null> {
  const row = await db.query.assistantThreads.findFirst({
    where: and(
      eq(assistantThreads.id, threadId),
      eq(assistantThreads.companyId, companyId),
      eq(assistantThreads.userId, userId),
    ),
  });
  return row ?? null;
}

export async function listMessages(threadId: string): Promise<AssistantMessage[]> {
  return db
    .select()
    .from(assistantMessages)
    .where(eq(assistantMessages.threadId, threadId))
    .orderBy(assistantMessages.createdAt);
}

export async function createThread(params: {
  companyId: string;
  userId: string;
  title?: string;
}): Promise<AssistantThread> {
  const [row] = await db
    .insert(assistantThreads)
    .values({
      companyId: params.companyId,
      userId: params.userId,
      title: params.title ?? 'New conversation',
    })
    .returning();
  if (!row) throw new Error('failed to create thread');
  return row;
}

export async function renameThread(
  companyId: string,
  userId: string,
  threadId: string,
  title: string,
): Promise<void> {
  await db
    .update(assistantThreads)
    .set({ title, updatedAt: new Date() })
    .where(
      and(
        eq(assistantThreads.id, threadId),
        eq(assistantThreads.companyId, companyId),
        eq(assistantThreads.userId, userId),
      ),
    );
}

export async function deleteThread(
  companyId: string,
  userId: string,
  threadId: string,
): Promise<void> {
  await db
    .delete(assistantThreads)
    .where(
      and(
        eq(assistantThreads.id, threadId),
        eq(assistantThreads.companyId, companyId),
        eq(assistantThreads.userId, userId),
      ),
    );
}

export async function appendUserMessage(
  threadId: string,
  text: string,
): Promise<AssistantMessage> {
  const [row] = await db
    .insert(assistantMessages)
    .values({
      threadId,
      role: 'user',
      content: [{ type: 'text', text }],
    })
    .returning();
  if (!row) throw new Error('failed to append user message');
  await db
    .update(assistantThreads)
    .set({ lastMessageAt: new Date(), updatedAt: new Date() })
    .where(eq(assistantThreads.id, threadId));
  return row;
}

export type AppendAssistantMessageInput = {
  threadId: string;
  content: AnthropicContentBlock[];
  stopReason: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  costCents: number;
};

export async function appendAssistantMessage(
  input: AppendAssistantMessageInput,
): Promise<AssistantMessage> {
  const [row] = await db
    .insert(assistantMessages)
    .values({
      threadId: input.threadId,
      role: 'assistant',
      content: input.content,
      stopReason: input.stopReason,
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      cacheCreationTokens: input.cacheCreationTokens,
      cacheReadTokens: input.cacheReadTokens,
      costUsdCents: input.costCents,
    })
    .returning();
  if (!row) throw new Error('failed to append assistant message');
  return row;
}

export async function appendToolResults(
  threadId: string,
  results: Array<{ tool_use_id: string; content: string; is_error?: boolean }>,
): Promise<void> {
  if (results.length === 0) return;
  await db.insert(assistantMessages).values({
    threadId,
    role: 'tool',
    content: results.map((r) => ({
      type: 'tool_result' as const,
      tool_use_id: r.tool_use_id,
      content: r.content,
      is_error: r.is_error ?? false,
    })),
  });
  await db
    .update(assistantThreads)
    .set({ lastMessageAt: new Date(), updatedAt: new Date() })
    .where(eq(assistantThreads.id, threadId));
}

/**
 * Rebuild Anthropic MessageParam history from persisted messages. Handles
 * user / assistant / tool rows. The tool rows are merged into the following
 * user message per Anthropic's API (tool_result blocks ride on a user turn).
 */
export function messagesToHistory(rows: AssistantMessage[]): AnthropicMessageParam[] {
  const out: AnthropicMessageParam[] = [];
  for (const m of rows) {
    if (m.role === 'user') {
      const blocks = m.content as AnthropicTextBlockParam[];
      const text = blocks.map((b) => ('text' in b ? b.text : '')).join('');
      out.push({ role: 'user', content: text });
    } else if (m.role === 'assistant') {
      out.push({
        role: 'assistant',
        content: m.content as AnthropicContentBlock[],
      });
    } else if (m.role === 'tool') {
      out.push({
        role: 'user',
        content: m.content as AnthropicToolResultBlockParam[],
      });
    }
  }
  return out;
}
