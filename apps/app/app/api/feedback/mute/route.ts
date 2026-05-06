import { NextResponse } from 'next/server';
import { z } from 'zod';
import {
  insertFeedbackEvent,
  insertSignalMuteRule,
  deleteSignalMuteRule,
} from '@procur/catalog';
import { getCurrentUser } from '@procur/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/feedback/mute
 * DELETE /api/feedback/mute
 *
 * Per docs/feedback-ui-brief.md §4.3. Mute is structural: the rule
 * filters future match-queue rows server-side via getMatchQueue's
 * userId param. POST also writes a feedback_events row for analytics.
 */
const BodySchema = z.object({
  entitySlug: z.string().min(1),
  signalType: z.string().min(1),
  signalSource: z.string().nullable().optional(),
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

  await insertSignalMuteRule({
    userId: user.id,
    entitySlug: parsed.data.entitySlug,
    signalType: parsed.data.signalType,
    signalSource: parsed.data.signalSource ?? null,
  });

  await insertFeedbackEvent({
    userId: user.id,
    feedbackKind: 'match_quality',
    targetType: 'entity',
    targetId: parsed.data.entitySlug,
    targetSecondaryId: parsed.data.signalSource ?? null,
    sentiment: 'mute',
    payload: {
      signal_type: parsed.data.signalType,
      signal_source: parsed.data.signalSource ?? null,
    },
    context: parsed.data.context ?? null,
  });

  return NextResponse.json({ ok: true });
}

export async function DELETE(req: Request): Promise<Response> {
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
  await deleteSignalMuteRule({
    userId: user.id,
    entitySlug: parsed.data.entitySlug,
    signalType: parsed.data.signalType,
    signalSource: parsed.data.signalSource ?? null,
  });
  return NextResponse.json({ ok: true });
}
