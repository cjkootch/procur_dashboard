import { NextResponse } from 'next/server';
import { z } from 'zod';
import { updateMatchQueueStatus } from '@procur/catalog';
import { getCurrentUser } from '@procur/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * PATCH /api/match-queue/[id]
 *   { status: 'dismissed' | 'pushed-to-vex' | 'actioned' | 'open' }
 *
 * Workflow transition for a match-queue row. Auth via the existing
 * Clerk middleware (any authenticated user — match queue is shared
 * in v1; per-user scoping comes later).
 */
const BodySchema = z.object({
  status: z.enum(['open', 'dismissed', 'pushed-to-vex', 'actioned']),
});

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const { id } = await params;
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }
  const parsed = BodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'bad_request', detail: parsed.error.flatten() },
      { status: 400 },
    );
  }

  await updateMatchQueueStatus({ id, status: parsed.data.status });
  return NextResponse.json({ ok: true });
}
