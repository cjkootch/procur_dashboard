import { NextResponse } from 'next/server';
import {
  streamAgentTurn,
  type AnthropicContentBlock,
  type PageContext,
  type StreamEvent,
} from '@procur/ai';
import { resolveAssistantContext } from '../../../../lib/assistant/context';
import { buildAssistantTools } from '../../../../lib/assistant/registry';
import {
  appendAssistantMessage,
  appendToolResults,
  appendUserMessage,
  createThread,
  getThread,
  listMessages,
  messagesToHistory,
} from '../../../../lib/assistant/threads';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type RequestAttachment = {
  url: string;
  contentType: string;
  filename: string;
};

type RequestBody = {
  threadId?: string;
  userText: string;
  pageContext?: PageContext;
  attachments?: RequestAttachment[];
};

const BLOB_URL_PREFIXES = [
  'https://blob.vercel-storage.com/',
  'https://public.blob.vercel-storage.com/',
];
function isAcceptableBlobUrl(url: string): boolean {
  // Only allow URLs that point at our Vercel Blob store, regardless
  // of the user-supplied content-type. Stops a model jailbreak from
  // pulling arbitrary URLs into the message context.
  if (BLOB_URL_PREFIXES.some((p) => url.startsWith(p))) return true;
  // Tenant-specific subdomains (vercel-storage.com is the canonical
  // host but Vercel mints `*.public.blob.vercel-storage.com` per
  // store).
  return /^https:\/\/[a-z0-9-]+\.public\.blob\.vercel-storage\.com\//.test(url);
}

const ALLOWED_ATTACHMENT_TYPES = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
]);

function sanitizeAttachments(
  raw: RequestAttachment[] | undefined,
): RequestAttachment[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (a): a is RequestAttachment =>
        !!a &&
        typeof a.url === 'string' &&
        typeof a.contentType === 'string' &&
        typeof a.filename === 'string',
    )
    .filter((a) => isAcceptableBlobUrl(a.url))
    .filter((a) => ALLOWED_ATTACHMENT_TYPES.has(a.contentType))
    .slice(0, 6); // hard cap to keep token + cost bounded per turn
}

export async function POST(req: Request): Promise<Response> {
  let body: RequestBody;
  try {
    body = (await req.json()) as RequestBody;
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }
  const attachments = sanitizeAttachments(body.attachments);
  // Allow attachment-only sends — the model treats the file as the
  // implicit prompt ("look at this and act"). userText must be a
  // string; empty is OK.
  if (typeof body.userText !== 'string') {
    return NextResponse.json({ error: 'missing_user_text' }, { status: 400 });
  }
  if (body.userText.length === 0 && attachments.length === 0) {
    return NextResponse.json({ error: 'missing_user_text' }, { status: 400 });
  }

  const ctx = await resolveAssistantContext(body.pageContext);
  const tools = buildAssistantTools();

  // Resolve or create the thread up-front so the client has an id to navigate to.
  let threadId = body.threadId;
  if (threadId) {
    const t = await getThread(ctx.companyId, ctx.userId, threadId);
    if (!t) return NextResponse.json({ error: 'thread_not_found' }, { status: 404 });
  } else {
    const t = await createThread({
      companyId: ctx.companyId,
      userId: ctx.userId,
      title: body.userText.slice(0, 60),
    });
    threadId = t.id;
  }

  await appendUserMessage(threadId, body.userText, attachments);
  const prior = await listMessages(threadId);
  // Drop the last message (the user text we just appended) — streamAgentTurn
  // takes it as a separate argument.
  const history = messagesToHistory(prior.slice(0, -1));

  const encoder = new TextEncoder();
  const resolvedThreadId = threadId;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: StreamEvent | { type: 'thread'; threadId: string }) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };
      send({ type: 'thread', threadId: resolvedThreadId });

      try {
        const pendingToolResults: Array<{
          tool_use_id: string;
          content: string;
          is_error?: boolean;
        }> = [];

        for await (const event of streamAgentTurn({
          ctx,
          tools,
          history,
          userText: body.userText,
          attachments,
          companyName: ctx.companyName,
          userFirstName: ctx.userFirstName,
          planTier: ctx.planTier,
        })) {
          send(event);

          if (event.type === 'assistant_message_complete') {
            // Anthropic requires tool_result blocks to sit on a user turn
            // *between* the tool_use assistant turn and the next assistant
            // turn. tool_result events arrive AFTER the prior
            // assistant_message_complete (the tool_use one), so by the
            // time *this* assistant_message_complete fires, anything in
            // pendingToolResults belongs to the previous assistant turn
            // and must be persisted BEFORE we save the current one.
            // Persisting in the wrong order corrupts the next replay
            // ("tool_use ids were found without tool_result blocks
            // immediately after").
            if (pendingToolResults.length > 0) {
              await appendToolResults(resolvedThreadId, pendingToolResults);
              pendingToolResults.length = 0;
            }
            await appendAssistantMessage({
              threadId: resolvedThreadId,
              content: event.content as AnthropicContentBlock[],
              stopReason: event.stopReason,
              inputTokens: event.usage.inputTokens,
              outputTokens: event.usage.outputTokens,
              cacheCreationTokens: event.usage.cacheCreationTokens,
              cacheReadTokens: event.usage.cacheReadTokens,
              costCents: event.usage.costCents,
            });
          } else if (event.type === 'tool_result') {
            pendingToolResults.push({
              tool_use_id: event.id,
              content: JSON.stringify(event.output).slice(0, 20000),
              is_error: event.isError,
            });
          }
        }

        // Flush any trailing tool results (shouldn't happen if loop ended
        // with end_turn, but belt-and-suspenders).
        if (pendingToolResults.length > 0) {
          await appendToolResults(resolvedThreadId, pendingToolResults);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        send({ type: 'error', message });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
