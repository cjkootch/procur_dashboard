import { NextResponse } from 'next/server';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { db, matchQueue, MATCH_DEAL_OUTCOMES } from '@procur/db';
import { verifyIntelligenceToken } from '../../../../lib/intelligence-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/intelligence/match-outcome
 *
 * Vex's match-feedback hook. Two distinct event types ride this same
 * endpoint, distinguished by which fields are set:
 *
 *   1. "deal created from match" — vex creates a fuel_deal from a
 *      match procur pushed earlier. Sets `vexDealId` on the row,
 *      records `pushedToVexAt` if not already set. No `outcome`.
 *
 *   2. "deal terminal" — the linked fuel_deal transitions to a
 *      closed state. Sets `dealOutcome` + `outcomeRecordedAt`, plus
 *      `realizedMarginUsd` when outcome='closed_won'.
 *
 * Match the procur match_queue row by either:
 *   - (sourceTable, sourceId) — the canonical procur key
 *   - vexDealId — when vex doesn't have the procur source IDs handy
 *     and is just updating a previously-linked row
 *
 * Idempotent. Re-posting the same outcome is a no-op.
 *
 * Auth: Authorization: Bearer ${PROCUR_API_TOKEN}.
 *
 * Brief: docs/data-graph-connections-brief.md §4 (work item 3).
 */

const BodySchema = z
  .object({
    sourceTable: z.string().min(1).optional(),
    sourceId: z.string().min(1).optional(),
    vexDealId: z.string().min(1).optional(),
    outcome: z.enum(MATCH_DEAL_OUTCOMES).optional(),
    /** Realized margin USD. Required when outcome='closed_won';
     *  otherwise null. */
    marginUsd: z.number().finite().optional(),
    /** When the deal terminated (ISO datetime). Defaults to now()
     *  when outcome is set without a timestamp. */
    occurredAt: z.string().datetime().optional(),
  })
  .refine(
    (b) => (b.sourceTable && b.sourceId) || b.vexDealId,
    {
      message: 'Provide either (sourceTable + sourceId) OR vexDealId to identify the match',
      path: ['sourceId'],
    },
  )
  .refine((b) => b.vexDealId != null || b.outcome != null, {
    message: 'Body must set vexDealId (link), outcome (terminal state), or both',
    path: ['outcome'],
  })
  .refine(
    (b) => b.outcome !== 'closed_won' || (b.marginUsd != null && b.marginUsd >= 0),
    {
      message: "marginUsd is required (and non-negative) when outcome='closed_won'",
      path: ['marginUsd'],
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
  const occurredAt = body.occurredAt ? new Date(body.occurredAt) : new Date();

  // Resolve the match_queue row. Prefer the canonical procur key
  // (sourceTable, sourceId) when present; fall back to vexDealId
  // for re-posting outcomes against an already-linked row.
  let where;
  if (body.sourceTable && body.sourceId) {
    where = and(
      eq(matchQueue.sourceTable, body.sourceTable),
      eq(matchQueue.sourceId, body.sourceId),
    );
  } else if (body.vexDealId) {
    where = eq(matchQueue.vexDealId, body.vexDealId);
  } else {
    // Schema refine should have caught this.
    return NextResponse.json({ error: 'unprocessable' }, { status: 422 });
  }

  const [target] = await db
    .select({
      id: matchQueue.id,
      status: matchQueue.status,
      pushedToVexAt: matchQueue.pushedToVexAt,
      vexDealId: matchQueue.vexDealId,
      dealOutcome: matchQueue.dealOutcome,
    })
    .from(matchQueue)
    .where(where)
    .limit(1);

  if (!target) {
    return NextResponse.json({ error: 'match_not_found' }, { status: 404 });
  }

  // Build the update set incrementally. Each event type carries
  // partial state; we never null-out something already set unless
  // the caller explicitly overrides (and the schema doesn't allow
  // that today — outcome flips are append-style).
  const updates: Partial<typeof matchQueue.$inferInsert> = {
    statusUpdatedAt: occurredAt,
  };

  if (body.vexDealId) {
    updates.vexDealId = body.vexDealId;
    if (target.pushedToVexAt == null) updates.pushedToVexAt = occurredAt;
    if (target.status === 'open') updates.status = 'pushed-to-vex';
  }

  if (body.outcome) {
    updates.dealOutcome = body.outcome;
    updates.outcomeRecordedAt = occurredAt;
    if (body.outcome === 'closed_won' && body.marginUsd != null) {
      updates.realizedMarginUsd = String(body.marginUsd);
    } else if (body.outcome !== 'closed_won') {
      // Defensive: clear any stale margin when outcome flips away
      // from closed_won (rare; outcome is typically terminal but
      // re-classification is allowed).
      updates.realizedMarginUsd = null;
    }
    // 'closed_won' / 'closed_lost' both imply the operator
    // actioned the match.
    if (body.outcome === 'closed_won' || body.outcome === 'closed_lost') {
      updates.status = 'actioned';
    }
  }

  await db.update(matchQueue).set(updates).where(eq(matchQueue.id, target.id));

  return NextResponse.json({
    matchId: target.id,
    applied: {
      vexDealId: updates.vexDealId ?? target.vexDealId,
      dealOutcome: updates.dealOutcome ?? target.dealOutcome,
    },
  });
}
