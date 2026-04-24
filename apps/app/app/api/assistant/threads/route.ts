import { NextResponse } from 'next/server';
import { resolveAssistantContext } from '../../../../lib/assistant/context';
import { listThreads } from '../../../../lib/assistant/threads';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  const ctx = await resolveAssistantContext();
  const threads = await listThreads(ctx.companyId, ctx.userId);
  return NextResponse.json({ threads });
}
