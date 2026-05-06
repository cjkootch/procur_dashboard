import { NextResponse } from 'next/server';
import { z } from 'zod';
import { logFrictionEvent } from '@procur/catalog';
import { getCurrentUser } from '@procur/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/feedback/friction
 *   { description, context?, scopedTargetType?, scopedTargetId? }
 *
 * Pattern 3 per docs/feedback-ui-brief.md §6. Inserts a
 * feedback_events row + opens a friction_status('logged') row in
 * one call so the analyst can later update lifecycle without
 * re-finding the original event.
 */
const BodySchema = z.object({
  description: z.string().min(3).max(4000),
  context: z.record(z.string(), z.unknown()).nullable().optional(),
  scopedTargetType: z.enum(['entity', 'deal', 'signal']).nullable().optional(),
  scopedTargetId: z.string().nullable().optional(),
});

export async function POST(req: Request): Promise<Response> {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
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
  const id = await logFrictionEvent({
    userId: user.id,
    description: parsed.data.description,
    context: parsed.data.context ?? null,
    scopedTargetType: parsed.data.scopedTargetType ?? null,
    scopedTargetId: parsed.data.scopedTargetId ?? null,
  });
  return NextResponse.json({ ok: true, id });
}
