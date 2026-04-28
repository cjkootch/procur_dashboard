import { NextResponse } from 'next/server';
import { resolveAssistantContext } from '../../../../../lib/assistant/context';
import { hydrateMessages } from '../../../../../lib/assistant/hydrate';
import {
  deleteThread,
  getThread,
  listMessages,
  renameThread,
} from '../../../../../lib/assistant/threads';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ threadId: string }> };

export async function GET(_req: Request, { params }: RouteContext): Promise<Response> {
  const { threadId } = await params;
  const ctx = await resolveAssistantContext();
  const thread = await getThread(ctx.companyId, ctx.userId, threadId);
  if (!thread) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  const messages = await listMessages(threadId);
  const rendered = hydrateMessages(messages);
  return NextResponse.json({ thread, messages, rendered });
}

export async function PATCH(req: Request, { params }: RouteContext): Promise<Response> {
  const { threadId } = await params;
  const ctx = await resolveAssistantContext();
  const body = (await req.json().catch(() => null)) as { title?: string } | null;
  if (!body?.title || typeof body.title !== 'string') {
    return NextResponse.json({ error: 'missing_title' }, { status: 400 });
  }
  await renameThread(ctx.companyId, ctx.userId, threadId, body.title.slice(0, 200));
  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: Request, { params }: RouteContext): Promise<Response> {
  const { threadId } = await params;
  const ctx = await resolveAssistantContext();
  await deleteThread(ctx.companyId, ctx.userId, threadId);
  return NextResponse.json({ ok: true });
}
