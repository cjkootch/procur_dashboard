import { NextResponse } from 'next/server';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { updateFrictionStatus } from '@procur/catalog';
import { getCurrentUser } from '@procur/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * PATCH /api/feedback/friction/[id]
 *   { status, resolutionNote?, relatedPrUrl? }
 *
 * Update the friction_status row for a logged friction event.
 * Used by /app/friction queue UI when the analyst (Cole) marks an
 * item reviewing / in_progress / shipped / wontfix. Auto-fills
 * resolved_at when terminal.
 */
const BodySchema = z.object({
  status: z.enum(['logged', 'reviewing', 'in_progress', 'shipped', 'wontfix']),
  resolutionNote: z.string().max(2000).nullable().optional(),
  relatedPrUrl: z.string().url().max(500).nullable().optional(),
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

  await updateFrictionStatus({
    feedbackEventId: id,
    status: parsed.data.status,
    resolutionNote: parsed.data.resolutionNote ?? null,
    relatedPrUrl: parsed.data.relatedPrUrl ?? null,
  });

  revalidatePath('/friction');
  return NextResponse.json({ ok: true });
}
