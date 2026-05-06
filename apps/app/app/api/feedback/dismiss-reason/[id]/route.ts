import { NextResponse } from 'next/server';
import { z } from 'zod';
import { addDismissReason } from '@procur/catalog';
import { getCurrentUser } from '@procur/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * PATCH /api/feedback/dismiss-reason/[id]
 *   { reason, freeText? }
 *
 * Pattern 1 dismiss-reason follow-up per brief §4.3. Called by the
 * 3-second-timeout dropdown to attach a reason to an already-
 * dispatched negative-sentiment feedback event.
 */
const REASONS = [
  'irrelevant_entity',
  'wrong_segment',
  'outdated_information',
  'duplicate',
  'other',
] as const;

const BodySchema = z.object({
  reason: z.enum(REASONS),
  freeText: z.string().max(500).nullable().optional(),
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
  await addDismissReason({
    feedbackEventId: id,
    userId: user.id,
    reason: parsed.data.reason,
    freeText: parsed.data.freeText ?? null,
  });
  return NextResponse.json({ ok: true });
}
