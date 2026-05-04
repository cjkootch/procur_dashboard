import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import {
  getThread,
  listMessages,
  type AnthropicContentBlock,
  type AnthropicDocumentBlockParam,
  type AnthropicImageBlockParam,
  type AnthropicTextBlockParam,
} from '@procur/ai';
import { db, companies, users, type AssistantMessage } from '@procur/db';
import { verifyDiscoverToken } from '@procur/utils';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ threadId: string }> };

/**
 * Fetch a thread's messages, hydrated for the Discover floating
 * widget. Discover renders a much simpler chat surface than the
 * main app — just user/assistant text bubbles with markdown — so we
 * collapse persisted content blocks into plain text rows here.
 *
 * Tool-result rows are dropped: Discover's widget silently absorbs
 * tool_use / tool_result events from the live SSE stream and never
 * renders them. Replaying them on history load would surface
 * never-before-seen content; better to just show what the user saw
 * in chat originally.
 */
export async function GET(req: Request, { params }: RouteContext): Promise<Response> {
  const { threadId } = await params;

  const authHeader = req.headers.get('authorization') ?? '';
  const token = authHeader.startsWith('Bearer ')
    ? authHeader.slice(7).trim()
    : null;
  const secret = process.env.DISCOVER_HANDSHAKE_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: 'server_misconfigured: DISCOVER_HANDSHAKE_SECRET not set' },
      { status: 500 },
    );
  }
  const claims = verifyDiscoverToken(token, secret);
  if (!claims) {
    return NextResponse.json({ error: 'invalid_or_expired_token' }, { status: 401 });
  }
  if (!claims.orgId) {
    return NextResponse.json({ error: 'no_company_context' }, { status: 403 });
  }

  const [companyRow, userRow] = await Promise.all([
    db.query.companies.findFirst({ where: eq(companies.clerkOrgId, claims.orgId) }),
    db.query.users.findFirst({ where: eq(users.clerkId, claims.userId) }),
  ]);
  if (!companyRow || !userRow) {
    return NextResponse.json({ error: 'company_or_user_not_synced' }, { status: 503 });
  }

  const thread = await getThread(companyRow.id, userRow.id, threadId);
  if (!thread) {
    return NextResponse.json({ error: 'thread_not_found' }, { status: 404 });
  }

  const messages = await listMessages(threadId);
  const rendered = hydrateForWidget(messages);
  return NextResponse.json({ thread, messages: rendered });
}

/** Collapse persisted content blocks into the simple {role, text}
 *  shape the Discover widget renders. User attachments aren't
 *  reconstituted (the widget doesn't support uploads anyway); tool
 *  rows are dropped (silent in v1, same as live stream). */
function hydrateForWidget(
  rows: AssistantMessage[],
): Array<{ role: 'user' | 'assistant'; text: string }> {
  const out: Array<{ role: 'user' | 'assistant'; text: string }> = [];
  for (const m of rows) {
    if (m.role === 'user') {
      const blocks = m.content as Array<
        AnthropicTextBlockParam | AnthropicImageBlockParam | AnthropicDocumentBlockParam
      >;
      const text = blocks
        .filter((b): b is AnthropicTextBlockParam => b.type === 'text')
        .map((b) => b.text)
        .join('');
      if (text.length > 0) {
        out.push({ role: 'user', text });
      }
    } else if (m.role === 'assistant') {
      const blocks = m.content as AnthropicContentBlock[];
      const text = blocks
        .filter((b): b is Extract<AnthropicContentBlock, { type: 'text' }> => b.type === 'text')
        .map((b) => b.text)
        .join('');
      if (text.length > 0) {
        out.push({ role: 'assistant', text });
      }
    }
    // role === 'tool' rows are intentionally skipped — see route docstring.
  }
  return out;
}
