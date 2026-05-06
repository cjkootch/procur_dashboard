import { NextResponse } from 'next/server';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import {
  PROCUR_INSIGHT_MATTERED_VALUES,
  insertFeedbackEvent,
  upsertDealRetrospective,
  type ProcurInsightMatteredValue,
} from '@procur/catalog';
import { getCurrentUser } from '@procur/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/feedback/retrospective
 *
 * Pattern 5 per docs/feedback-ui-brief.md §8. Upserts the
 * (deal, user) retrospective row + logs feedback_events on
 * non-draft completion (drafts don't generate analytics events
 * yet — they're work-in-progress, not signal).
 */
const BodySchema = z.object({
  dealId: z.string().min(1),
  dealOutcome: z.enum(['won', 'lost', 'dead']),
  initialSignalSource: z.string().max(500).nullable().optional(),
  daysSignalToClose: z.number().int().min(0).nullable().optional(),
  criticalMoments: z.string().max(4000).nullable().optional(),
  procurInsightMattered: z
    .enum(
      PROCUR_INSIGHT_MATTERED_VALUES as readonly [
        ProcurInsightMatteredValue,
        ...ProcurInsightMatteredValue[],
      ],
    )
    .nullable()
    .optional(),
  whatWouldHaveHelped: z.string().max(4000).nullable().optional(),
  patternForFuture: z.string().max(4000).nullable().optional(),
  isDraft: z.boolean().default(false),
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

  const id = await upsertDealRetrospective({
    dealId: parsed.data.dealId,
    userId: user.id,
    dealOutcome: parsed.data.dealOutcome,
    initialSignalSource: parsed.data.initialSignalSource ?? null,
    daysSignalToClose: parsed.data.daysSignalToClose ?? null,
    criticalMoments: parsed.data.criticalMoments ?? null,
    procurInsightMattered: parsed.data.procurInsightMattered ?? null,
    whatWouldHaveHelped: parsed.data.whatWouldHaveHelped ?? null,
    patternForFuture: parsed.data.patternForFuture ?? null,
    isDraft: parsed.data.isDraft,
  });

  // Only completed retrospectives generate analytics events; drafts
  // are work-in-progress, not signal.
  if (!parsed.data.isDraft) {
    await insertFeedbackEvent({
      userId: user.id,
      feedbackKind: 'retrospective',
      targetType: 'deal',
      targetId: parsed.data.dealId,
      sentiment: 'neutral',
      payload: {
        deal_outcome: parsed.data.dealOutcome,
        procur_insight_mattered: parsed.data.procurInsightMattered ?? null,
        days_signal_to_close: parsed.data.daysSignalToClose ?? null,
        pattern_for_future: parsed.data.patternForFuture ?? null,
      },
      context: { page: `/retrospectives/${parsed.data.dealId}` },
    });
  }

  revalidatePath(`/retrospectives/${parsed.data.dealId}`);
  return NextResponse.json({ ok: true, id });
}
