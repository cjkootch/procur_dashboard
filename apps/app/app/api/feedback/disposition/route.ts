import { NextResponse } from 'next/server';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import {
  ENTITY_DISPOSITIONS,
  insertFeedbackEvent,
  setEntityDisposition,
  type EntityDispositionValue,
} from '@procur/catalog';
import { getCurrentUser } from '@procur/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/feedback/disposition
 *   { entitySlug, disposition, declineReason?, oldDisposition?,
 *     triggeringInteraction? }
 *
 * Pattern 4 per docs/feedback-ui-brief.md §7. Sets the user's
 * current disposition for the entity (supersedes prior) + logs a
 * feedback_events row for analytics.
 */
const BodySchema = z.object({
  entitySlug: z.string().min(1),
  disposition: z.enum(
    ENTITY_DISPOSITIONS as readonly [EntityDispositionValue, ...EntityDispositionValue[]],
  ),
  declineReason: z.string().max(2000).nullable().optional(),
  oldDisposition: z.string().nullable().optional(),
  triggeringInteraction: z.string().nullable().optional(),
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
  if (parsed.data.disposition === 'declined' && !parsed.data.declineReason) {
    return NextResponse.json(
      { error: 'bad_request', detail: 'declineReason required for declined' },
      { status: 400 },
    );
  }

  await setEntityDisposition({
    entitySlug: parsed.data.entitySlug,
    userId: user.id,
    disposition: parsed.data.disposition,
    declineReason: parsed.data.declineReason ?? null,
  });

  await insertFeedbackEvent({
    userId: user.id,
    feedbackKind: 'disposition',
    targetType: 'entity',
    targetId: parsed.data.entitySlug,
    sentiment: 'neutral',
    payload: {
      old_disposition: parsed.data.oldDisposition ?? null,
      new_disposition: parsed.data.disposition,
      decline_reason: parsed.data.declineReason ?? null,
      triggering_interaction: parsed.data.triggeringInteraction ?? null,
    },
    context: { page: `/entities/${parsed.data.entitySlug}` },
  });

  revalidatePath(`/entities/${parsed.data.entitySlug}`);
  return NextResponse.json({ ok: true });
}
