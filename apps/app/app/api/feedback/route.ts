import { NextResponse } from 'next/server';
import { z } from 'zod';
import { insertFeedbackEvent } from '@procur/catalog';
import { getCurrentUser } from '@procur/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/feedback
 *
 * Single insert path for all five feedback patterns per
 * docs/feedback-ui-brief.md §3.1. Pattern-specific data goes in
 * payload + context. Returns the inserted event id so the client
 * can correlate (e.g. dismiss-reason follow-up within 3-second
 * timeout window).
 */
const BodySchema = z.object({
  feedbackKind: z.enum([
    'match_quality',
    'entity_attribute',
    'friction',
    'disposition',
    'retrospective',
  ]),
  targetType: z.enum(['match', 'entity', 'signal', 'deal', 'global']).nullable().optional(),
  targetId: z.string().nullable().optional(),
  targetSecondaryId: z.string().nullable().optional(),
  sentiment: z
    .enum(['positive', 'negative', 'neutral', 'mute', 'pin'])
    .nullable()
    .optional(),
  payload: z.record(z.string(), z.unknown()).default({}),
  context: z.record(z.string(), z.unknown()).nullable().optional(),
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

  const id = await insertFeedbackEvent({
    userId: user.id,
    feedbackKind: parsed.data.feedbackKind,
    targetType: parsed.data.targetType ?? null,
    targetId: parsed.data.targetId ?? null,
    targetSecondaryId: parsed.data.targetSecondaryId ?? null,
    sentiment: parsed.data.sentiment ?? null,
    payload: parsed.data.payload,
    context: parsed.data.context ?? null,
  });

  return NextResponse.json({ ok: true, id });
}
