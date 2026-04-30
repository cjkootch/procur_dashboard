import type {
  AnthropicContentBlock,
  AnthropicDocumentBlockParam,
  AnthropicImageBlockParam,
  AnthropicTextBlockParam,
  AnthropicToolResultBlockParam,
} from '@procur/ai';
import type { AssistantMessage } from '@procur/db';
import type {
  ChatAttachment,
  RenderedMessage,
  RenderedToolUse,
} from '../../components/assistant/types';

/**
 * Convert persisted `assistant_messages` rows into the `RenderedMessage`
 * shape the Chat component displays. Tool rows are merged into the
 * preceding assistant message so the UI sees a single message with
 * its tool_use + result pair.
 *
 * Lives here (shared lib) rather than colocated with the [threadId]
 * page so the API route at /api/assistant/threads/[threadId] can
 * return pre-rendered messages too — needed by the drawer to rehydrate
 * the conversation when the user reopens it.
 */
export function hydrateMessages(rows: AssistantMessage[]): RenderedMessage[] {
  const out: RenderedMessage[] = [];
  for (const m of rows) {
    if (m.role === 'user') {
      const blocks = m.content as Array<
        | AnthropicTextBlockParam
        | AnthropicImageBlockParam
        | AnthropicDocumentBlockParam
      >;
      let text = '';
      const attachments: ChatAttachment[] = [];
      for (const b of blocks) {
        if (b.type === 'text') {
          text += b.text;
        } else if (b.type === 'image' && b.source.type === 'url') {
          attachments.push({
            url: b.source.url,
            contentType: 'image/*',
            // We don't know the original filename from the persisted
            // block; derive from the URL path's last segment.
            filename: filenameFromUrl(b.source.url),
          });
        } else if (b.type === 'document' && b.source.type === 'url') {
          attachments.push({
            url: b.source.url,
            contentType: 'application/pdf',
            filename: b.title ?? filenameFromUrl(b.source.url),
          });
        }
      }
      out.push({
        id: m.id,
        kind: 'user',
        text,
        attachments: attachments.length > 0 ? attachments : undefined,
      });
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

function filenameFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const last = u.pathname.split('/').filter(Boolean).pop();
    return last ? decodeURIComponent(last) : 'attachment';
  } catch {
    return 'attachment';
  }
}
