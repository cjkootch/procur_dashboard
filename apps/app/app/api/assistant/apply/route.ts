import { NextResponse } from 'next/server';
import { resolveAssistantContext } from '../../../../lib/assistant/context';
import { applyProposal } from '../../../../lib/assistant/apply';
import { getThread } from '../../../../lib/assistant/threads';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type RequestBody = {
  threadId: string;
  toolName: string;
  applyPayload: unknown;
};

export async function POST(req: Request): Promise<Response> {
  let body: RequestBody;
  try {
    body = (await req.json()) as RequestBody;
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }
  if (!body.threadId || !body.toolName) {
    return NextResponse.json({ error: 'missing_fields' }, { status: 400 });
  }

  const ctx = await resolveAssistantContext();
  const thread = await getThread(ctx.companyId, ctx.userId, body.threadId);
  if (!thread) return NextResponse.json({ error: 'thread_not_found' }, { status: 404 });

  const result = await applyProposal(
    { companyId: ctx.companyId, userId: ctx.userId, threadId: body.threadId },
    body.toolName,
    body.applyPayload,
  );
  return NextResponse.json(result, { status: result.ok ? 200 : 400 });
}
