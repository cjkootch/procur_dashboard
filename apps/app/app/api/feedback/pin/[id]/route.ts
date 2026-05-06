import { NextResponse } from 'next/server';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { extendPinnedMatch, revokePinnedMatch } from '@procur/catalog';
import { getCurrentUser } from '@procur/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Pattern 1 pin lifecycle (brief §4.3):
 *   PATCH  /api/feedback/pin/[id]   { action: 'extend', days?: number }
 *   DELETE /api/feedback/pin/[id]   — soft-delete via revoked_at
 *
 * Used by /pinned page Extend / Unpin actions. Authorization
 * checks user_id on the row to prevent extending someone else's pin.
 */
const ExtendSchema = z.object({
  action: z.literal('extend'),
  days: z.number().int().min(1).max(365).optional(),
});

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const { id } = await params;
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }
  const parsed = ExtendSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'bad_request', detail: parsed.error.flatten() },
      { status: 400 },
    );
  }
  await extendPinnedMatch({
    feedbackEventId: id,
    userId: user.id,
    days: parsed.data.days,
  });
  revalidatePath('/pinned');
  return NextResponse.json({ ok: true });
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const { id } = await params;
  await revokePinnedMatch({ feedbackEventId: id, userId: user.id });
  revalidatePath('/pinned');
  return NextResponse.json({ ok: true });
}
