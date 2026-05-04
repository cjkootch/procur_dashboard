import { NextResponse } from 'next/server';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import {
  db,
  matchOutcomeEvents,
  matchQueue,
  MATCH_DEAL_OUTCOMES,
} from '@procur/db';
import { verifyIntelligenceToken } from '../../../../lib/intelligence-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/intelligence/match-outcome
 *
 * Vex's match-outcome feedback hook (vex PR #309). Vex POSTs every
 * time a fuel_deal lifecycle event would be useful for our
 * match-queue feedback model:
 *
 *   created       — vex created a fuel_deal from a procur lead
 *   closed_won    — deal settled
 *   closed_lost   — deal cancelled / failed
 *   no_engagement — 90d procur lead with no related fuel_deal
 *
 * Append-only semantics: the same `procur_opportunity_id` will
 * legitimately produce multiple events (created, then later
 * closed_won). Each event lands as a row in `match_outcome_events`,
 * keyed on (procur_opportunity_id, outcome). Duplicates noop via
 * `ON CONFLICT DO NOTHING`.
 *
 * Best-effort denormalization: when the procur_opportunity_id
 * encodes a `match-queue:<uuid>` pattern (set by our push code in
 * `apps/app/app/api/match-queue/[id]/push-to-vex`), we also update
 * the source `match_queue` row's vexDealId / dealOutcome / etc. for
 * the operator UI's "current state" read path. The event log is
 * still canonical.
 *
 * Auth: Authorization: Bearer ${PROCUR_API_TOKEN}.
 *
 * Schema is vex's snake_case wire shape verbatim; we re-shape
 * internally to camelCase for the Drizzle layer. Backward compat
 * with the old camelCase wire shape (sourceTable + sourceId +
 * outcome + marginUsd) is dropped — that endpoint had never
 * received a real call from vex (their integration shipped with
 * the snake_case shape from day 1).
 */

const BodySchema = z
  .object({
    procur_opportunity_id: z.string().min(1),
    outcome: z.enum(MATCH_DEAL_OUTCOMES),
    vex_deal_id: z.string().min(1).nullish(),
    vex_deal_ref: z.string().min(1).nullish(),
    outcome_note: z.string().max(4000).nullish(),
    reported_at: z.string().datetime(),
    source: z.literal('vex'),
  })
  .refine(
    // 'created' implies the deal exists in vex — require the deal id.
    (b) => (b.outcome === 'created' ? b.vex_deal_id != null : true),
    {
      message: "vex_deal_id is required when outcome='created'",
      path: ['vex_deal_id'],
    },
  );

export async function POST(req: Request): Promise<Response> {
  const auth = verifyIntelligenceToken(req);
  if (auth) return auth;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }
  const parsed = BodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'unprocessable', detail: parsed.error.flatten() },
      { status: 422 },
    );
  }
  const body = parsed.data;
  const reportedAt = new Date(body.reported_at);

  // Insert into the canonical event log first. Idempotent — duplicate
  // (procurOpportunityId, outcome) returns the existing row's id.
  const eventInsert = await db
    .insert(matchOutcomeEvents)
    .values({
      procurOpportunityId: body.procur_opportunity_id,
      outcome: body.outcome,
      vexDealId: body.vex_deal_id ?? null,
      vexDealRef: body.vex_deal_ref ?? null,
      outcomeNote: body.outcome_note ?? null,
      reportedAt,
      source: 'vex',
    })
    .onConflictDoNothing({
      target: [matchOutcomeEvents.procurOpportunityId, matchOutcomeEvents.outcome],
    })
    .returning({ id: matchOutcomeEvents.id });
  const recorded = eventInsert.length > 0;

  // Best-effort: when procur_opportunity_id encodes a match_queue
  // UUID, denormalize the latest state onto the row so the operator
  // UI's "current state" read path stays accurate. Pattern sent by
  // apps/app/app/api/match-queue/[id]/push-to-vex:
  //   match-queue:<uuid>            (no entity profile)
  //   match-queue:<uuid>:<slug>     (entity profile resolved)
  const matchUuid = parseMatchQueueUuid(body.procur_opportunity_id);
  let matchSynced = false;
  if (matchUuid) {
    const updates: Partial<typeof matchQueue.$inferInsert> = {
      statusUpdatedAt: reportedAt,
    };
    if (body.vex_deal_id) updates.vexDealId = body.vex_deal_id;
    if (body.outcome === 'created') {
      // Vex set vex_deal_id and `pushedToVexAt` (which our push code
      // set when status flipped to 'pushed-to-vex'). The 'created'
      // event is informational here — the row was already at
      // 'pushed-to-vex' from the push side.
    } else {
      // Terminal outcomes: stamp the dealOutcome column + flip
      // status to 'actioned' for closed_won/closed_lost so the
      // queue de-duplicates.
      updates.dealOutcome = body.outcome;
      updates.outcomeRecordedAt = reportedAt;
      if (body.outcome === 'closed_won' || body.outcome === 'closed_lost') {
        updates.status = 'actioned';
      }
    }

    const [updated] = await db
      .update(matchQueue)
      .set(updates)
      .where(eq(matchQueue.id, matchUuid))
      .returning({ id: matchQueue.id });
    matchSynced = updated != null;
  }

  return NextResponse.json({
    recorded,
    matchSynced,
    procurOpportunityId: body.procur_opportunity_id,
    outcome: body.outcome,
  });
}

/**
 * Extract the match_queue UUID from a procur_opportunity_id when it
 * has the `match-queue:<uuid>...` prefix. Returns null when the
 * sourceRef wasn't generated by our push-to-vex path (other origins
 * may follow once we expand the push surface — they'll need their
 * own parsers added here).
 */
function parseMatchQueueUuid(procurOpportunityId: string): string | null {
  const match = /^match-queue:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(
    procurOpportunityId,
  );
  return match?.[1] ?? null;
}

