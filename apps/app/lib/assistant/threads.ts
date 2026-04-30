import 'server-only';
import { and, desc, eq } from 'drizzle-orm';
import type {
  AnthropicContentBlock,
  AnthropicDocumentBlockParam,
  AnthropicImageBlockParam,
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

/** Per-turn user attachment shape, mirrored across the API + the
 *  AI stream layer. Persisted as image/document content blocks. */
export type UserAttachment = {
  url: string;
  contentType: string;
  filename: string;
};

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
  attachments?: UserAttachment[],
): Promise<AssistantMessage> {
  // Build the content-block array. Always include the text block
  // (even when empty — keeps the schema uniform for attachment-only
  // turns; messagesToHistory handles the all-empty case). Then
  // append image/document blocks for any attachments.
  const blocks: Array<
    AnthropicTextBlockParam | AnthropicImageBlockParam | AnthropicDocumentBlockParam
  > = [{ type: 'text', text }];
  for (const a of attachments ?? []) {
    if (a.contentType === 'application/pdf') {
      blocks.push({
        type: 'document',
        source: { type: 'url', url: a.url },
        title: a.filename,
      });
    } else if (a.contentType.startsWith('image/')) {
      blocks.push({
        type: 'image',
        source: { type: 'url', url: a.url },
      });
    }
  }
  const [row] = await db
    .insert(assistantMessages)
    .values({
      threadId,
      role: 'user',
      content: blocks,
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
 * Block types produced by Anthropic's code-execution-backed server
 * tools (web_search_20260209, web_fetch_20260209, code_execution).
 * These reference a sandboxed container that expires (~1h), so we
 * can't reliably replay them on follow-up user turns — the API
 * would demand the original container_id, and even threading it
 * through doesn't survive expiry. Stripping them lets the
 * conversation continue; the model loses inline citations from
 * prior turns but text summaries written into prior assistant
 * messages survive.
 */
const SERVER_TOOL_BLOCK_TYPES = new Set([
  'server_tool_use',
  'web_search_tool_result',
  'web_fetch_tool_result',
  'code_execution_tool_result',
  'bash_code_execution_tool_result',
  'text_editor_code_execution_tool_result',
]);

/**
 * Rebuild Anthropic MessageParam history from persisted messages. Handles
 * user / assistant / tool rows. The tool rows are merged into the following
 * user message per Anthropic's API (tool_result blocks ride on a user turn).
 */
export function messagesToHistory(rows: AssistantMessage[]): AnthropicMessageParam[] {
  const out: AnthropicMessageParam[] = [];
  for (const m of rows) {
    if (m.role === 'user') {
      // User turns can carry image / document blocks alongside text
      // (PDFs / screenshots dropped into the composer). Preserve
      // those blocks so re-sent history still shows the model what
      // the user attached. When the only content is a single text
      // block, collapse to the legacy string shape so the
      // prompt-cache key stays stable for text-only conversations.
      const blocks = m.content as Array<
        | AnthropicTextBlockParam
        | AnthropicImageBlockParam
        | AnthropicDocumentBlockParam
      >;
      const filtered = blocks.filter((b) => {
        if (b.type === 'text') return b.text.length > 0;
        return b.type === 'image' || b.type === 'document';
      });
      if (filtered.length === 0) {
        // Empty user turn would be rejected by the API. Skip rather
        // than crash; in practice this only happens on legacy rows.
        continue;
      }
      if (filtered.length === 1 && filtered[0]!.type === 'text') {
        out.push({
          role: 'user',
          content: (filtered[0] as AnthropicTextBlockParam).text,
        });
      } else {
        out.push({ role: 'user', content: filtered });
      }
    } else if (m.role === 'assistant') {
      const content = (m.content as AnthropicContentBlock[]).filter(
        (b) => !SERVER_TOOL_BLOCK_TYPES.has(b.type),
      );
      // An assistant turn that was 100% server-tool blocks (rare but
      // possible if the model only fetched and we trimmed it all)
      // would become an empty content array, which the API rejects.
      // Skip it in that case.
      if (content.length === 0) continue;
      out.push({ role: 'assistant', content });
    } else if (m.role === 'tool') {
      out.push({
        role: 'user',
        content: m.content as AnthropicToolResultBlockParam[],
      });
    }
  }
  return out;
}
