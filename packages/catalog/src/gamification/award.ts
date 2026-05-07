import 'server-only';
import {
  db,
  notifications,
  users,
  xpLedger,
  type NewXpLedgerRow,
} from '@procur/db';
import { and, eq, gte, isNotNull, sql } from 'drizzle-orm';
import { FIRST_OF_DAY_BONUS, streakMultiplier, xpRuleFor } from './xp-rules';
import { levelFromXp } from './levels';
import { getCurrentStreakDays } from './streak';

export interface AwardXpInput {
  userId: string;
  /** events.id when the action emitted one. Optional. */
  eventId?: string | null;
  sourceTable?: string | null;
  sourceId?: string | null;
  verb: string;
  /** Override the XP rule's reason — e.g. quest completes ride a custom string. */
  reason?: string;
  /** Override the XP rule's points — used for quest completes. */
  points?: number;
  occurredAt?: Date;
}

export interface AwardXpResult {
  awarded: boolean;
  ledgerId?: string;
  pointsAwarded?: number;
  /** True when this award crossed a level boundary. */
  levelUp?: { fromLevel: number; toLevel: number; toName: string };
}

/**
 * Credit XP for an action. Called inline from existing event-emit
 * sites (emitOutreachOutcome, insertFeedbackEvent, resolveEntityMention,
 * upsertSupplierApproval, deal-retrospective writers). Never throws —
 * the parent action must succeed even if gamification fails.
 *
 * Does the following, in order:
 *   1. Resolve the verb to a base point value via xpRuleFor (or use
 *      the explicit override for quest / achievement / manual).
 *   2. Apply streak multiplier + first-of-day bonus.
 *   3. Compute previous total to detect level-up after the insert.
 *   4. Insert ledger row (idempotent on (source_table, source_id, verb)
 *      via the unique partial index).
 *   5. Emit `gamification.xp_gained` notification (and `gamification.
 *      level_up` if the level changed).
 *
 * Returns `{ awarded: false }` when no rule exists for the verb and
 * no override was passed. Skipping silently is intentional — new
 * event types should not block the parent action just because the
 * XP rule table is missing them.
 */
export async function awardXp(
  input: AwardXpInput,
): Promise<AwardXpResult> {
  try {
    let basePoints: number | null = null;
    let reason: string | null = null;
    if (input.points != null) {
      basePoints = input.points;
      reason = input.reason ?? input.verb;
    } else {
      const rule = xpRuleFor(input.verb);
      if (rule) {
        basePoints = rule.points;
        reason = input.reason ?? rule.reason;
      }
    }
    if (basePoints == null || reason == null) {
      return { awarded: false };
    }
    if (basePoints === 0) {
      return { awarded: false };
    }

    // Compute previous total for level-up detection.
    const prevRows = await db
      .select({ total: sql<number>`COALESCE(SUM(${xpLedger.points}), 0)::int` })
      .from(xpLedger)
      .where(eq(xpLedger.userId, input.userId));
    const prevTotal = Number(prevRows[0]?.total ?? 0);

    // First-of-day bonus + streak multiplier.
    const startOfTodayUtc = new Date();
    startOfTodayUtc.setUTCHours(0, 0, 0, 0);
    const todayRows = await db
      .select({ count: sql<number>`COUNT(*)::int` })
      .from(xpLedger)
      .where(
        and(
          eq(xpLedger.userId, input.userId),
          gte(xpLedger.occurredAt, startOfTodayUtc),
        ),
      );
    const isFirstOfDay = Number(todayRows[0]?.count ?? 0) === 0;

    const streak = await getCurrentStreakDays(input.userId);
    const multiplier = streakMultiplier(streak);
    const adjustedBase = Math.round(basePoints * multiplier);
    const totalPoints = adjustedBase + (isFirstOfDay ? FIRST_OF_DAY_BONUS : 0);

    const row: NewXpLedgerRow = {
      userId: input.userId,
      eventId: input.eventId ?? null,
      sourceTable: input.sourceTable ?? null,
      sourceId: input.sourceId ?? null,
      verb: input.verb,
      points: totalPoints,
      reason,
      occurredAt: input.occurredAt ?? new Date(),
    };

    const inserted = await db
      .insert(xpLedger)
      .values(row)
      .onConflictDoNothing({
        target: [xpLedger.sourceTable, xpLedger.sourceId, xpLedger.verb],
      })
      .returning({ id: xpLedger.id });
    if (inserted.length === 0) {
      // Idempotency hit — already credited for this source row.
      return { awarded: false };
    }

    const newTotal = prevTotal + totalPoints;
    const before = levelFromXp(prevTotal);
    const after = levelFromXp(newTotal);
    const levelUp =
      after.level > before.level
        ? { fromLevel: before.level, toLevel: after.level, toName: after.name }
        : null;

    await fanoutXpNotification({
      userId: input.userId,
      reason,
      points: totalPoints,
      bonusFirstOfDay: isFirstOfDay,
      multiplier,
      levelUp,
    });

    return {
      awarded: true,
      ledgerId: inserted[0]!.id,
      pointsAwarded: totalPoints,
      ...(levelUp ? { levelUp } : {}),
    };
  } catch (err) {
    console.error('[gamification] awardXp failed', err, {
      userId: input.userId,
      verb: input.verb,
    });
    return { awarded: false };
  }
}

/**
 * Emit `gamification.xp_gained` (and optional `gamification.level_up`)
 * notifications. Inline rather than going through the app-layer
 * notifyAllOperators helper (catalog can't import from apps/app).
 * Single-user lock-in (Phase 0) means we only need to notify the
 * user the action belongs to.
 */
async function fanoutXpNotification(input: {
  userId: string;
  reason: string;
  points: number;
  bonusFirstOfDay: boolean;
  multiplier: number;
  levelUp: { fromLevel: number; toLevel: number; toName: string } | null;
}): Promise<void> {
  const userRow = await db
    .select({ companyId: users.companyId })
    .from(users)
    .where(and(eq(users.id, input.userId), isNotNull(users.companyId)))
    .limit(1);
  const companyId = userRow[0]?.companyId ?? null;
  if (!companyId) return;

  const trail: string[] = [];
  if (input.bonusFirstOfDay) trail.push('first action of the day');
  if (input.multiplier > 1) trail.push(`${input.multiplier.toFixed(2)}× streak`);
  const suffix = trail.length ? ` (${trail.join(', ')})` : '';

  await db.insert(notifications).values({
    userId: input.userId,
    companyId,
    type: 'gamification.xp_gained',
    title: `+${input.points} XP — ${input.reason}${suffix}`,
    body: null,
    link: '/',
    entityType: null,
    entityId: null,
  });

  if (input.levelUp) {
    await db.insert(notifications).values({
      userId: input.userId,
      companyId,
      type: 'gamification.level_up',
      title: `Level ${input.levelUp.toLevel} — ${input.levelUp.toName}`,
      body: `You leveled up. Welcome to ${input.levelUp.toName}.`,
      link: '/',
      entityType: null,
      entityId: null,
    });
  }
}
