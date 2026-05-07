import 'server-only';
import { and, eq, isNotNull, sql } from 'drizzle-orm';
import {
  achievementsEarned,
  db,
  notifications,
  users,
  xpLedger,
  type AchievementEarnedRow,
} from '@procur/db';
import { awardXp } from './award';
import { levelFromXp } from './levels';
import { getCurrentStreakDays } from './streak';

/**
 * Long-form achievement layer (Slice 3). Each achievement is a stable
 * key + a predicate over the database. `evaluateAchievements(userId)`
 * runs the registry and unlocks anything that's transitioned from
 * locked → criterion-met since the last call.
 *
 * Storage: `achievements_earned` (one row per (user, key); UNIQUE
 * constraint makes the unlock idempotent). The predicate registry is
 * code-as-config — no editor UI, no schema. When predicates need
 * tuning, edit this file and ship a PR.
 *
 * Every unlock fires:
 *   - an `xp_ledger` credit via `awardXp` (verb=`achievement.<key>`,
 *     points=xpReward, sourceTable='achievement', sourceId=key —
 *     idempotent on the unique partial index)
 *   - a `gamification.achievement_unlocked` notification (more
 *     prominent than the steady-state xp_gained toast)
 *
 * Predicates are bare SQL/JS; keep them cheap so the post-action
 * evaluation pass stays fast. On a single-user database these all
 * resolve in single-digit ms.
 */

export type AchievementCategory =
  | 'outreach'
  | 'kyc'
  | 'deals'
  | 'discipline'
  | 'ml'
  | 'meta';

export interface AchievementDefinition {
  key: string;
  name: string;
  description: string;
  /** Short emoji or text glyph rendered on the badge tile. */
  icon: string;
  category: AchievementCategory;
  xpReward: number;
  /** Returns true when the criterion is currently met. Pure read. */
  predicate: (userId: string) => Promise<boolean>;
}

async function existsRow(query: ReturnType<typeof sql>): Promise<boolean> {
  const rows = await db.execute<{ ok: boolean }>(query);
  return Boolean(rows.rows[0]?.ok);
}

async function countAtLeast(
  query: ReturnType<typeof sql>,
  threshold: number,
): Promise<boolean> {
  const rows = await db.execute<{ n: number }>(query);
  return Number(rows.rows[0]?.n ?? 0) >= threshold;
}

export const ACHIEVEMENT_REGISTRY: AchievementDefinition[] = [
  // ── Outreach ────────────────────────────────────────────────────
  {
    key: 'first_light',
    name: 'First Light',
    description: 'Send your first outreach.',
    icon: '✉️',
    category: 'outreach',
    xpReward: 10,
    predicate: () =>
      existsRow(sql`
        SELECT EXISTS(
          SELECT 1 FROM events WHERE verb = 'outreach.sent'
        ) AS ok
      `),
  },
  {
    key: 'first_reply',
    name: 'First Reply',
    description: 'Receive your first inbound reply.',
    icon: '💬',
    category: 'outreach',
    xpReward: 50,
    predicate: () =>
      existsRow(sql`
        SELECT EXISTS(
          SELECT 1 FROM events WHERE verb = 'outreach.replied'
        ) AS ok
      `),
  },
  {
    key: 'cold_start_cracked',
    name: 'Cold Start Cracked',
    description: 'Reply received from an entity you had zero prior touchpoints with.',
    icon: '❄️',
    category: 'outreach',
    xpReward: 100,
    predicate: () =>
      existsRow(sql`
        SELECT EXISTS(
          SELECT 1
          FROM events e
          WHERE e.verb = 'outreach.replied'
            AND e.metadata ? 'entity_slug'
            AND NOT EXISTS (
              SELECT 1 FROM entity_activity_observations o
              WHERE o.entity_slug = (e.metadata->>'entity_slug')
                AND o.observed_at < e.occurred_at
            )
        ) AS ok
      `),
  },
  {
    key: 'world_tour',
    name: 'World Tour',
    description: 'Send outreach to entities in 10 distinct countries.',
    icon: '🗺️',
    category: 'outreach',
    xpReward: 200,
    predicate: () =>
      countAtLeast(
        sql`
          SELECT COUNT(DISTINCT ke.country_code)::int AS n
          FROM events e
          JOIN known_entities ke ON ke.slug = (e.metadata->>'entity_slug')
          WHERE e.verb = 'outreach.sent'
            AND ke.country_code IS NOT NULL
        `,
        10,
      ),
  },

  // ── KYC ─────────────────────────────────────────────────────────
  {
    key: 'kyc_cleared',
    name: 'KYC Cleared',
    description: 'Land your first fully-KYC-approved supplier.',
    icon: '🛡️',
    category: 'kyc',
    xpReward: 100,
    predicate: () =>
      existsRow(sql`
        SELECT EXISTS(
          SELECT 1 FROM supplier_approvals WHERE status = 'approved_with_kyc'
        ) AS ok
      `),
  },
  {
    key: 'quartermaster',
    name: 'Quartermaster',
    description: 'Reach 10 KYC-approved suppliers.',
    icon: '⚓',
    category: 'kyc',
    xpReward: 300,
    predicate: () =>
      countAtLeast(
        sql`
          SELECT COUNT(*)::int AS n
          FROM supplier_approvals
          WHERE status = 'approved_with_kyc'
        `,
        10,
      ),
  },

  // ── Deals ───────────────────────────────────────────────────────
  {
    key: 'first_fill',
    name: 'First Fill',
    description: 'Convert your first outreach to a deal.',
    icon: '🎯',
    category: 'deals',
    xpReward: 200,
    predicate: () =>
      existsRow(sql`
        SELECT EXISTS(
          SELECT 1 FROM events WHERE verb = 'outreach.converted_to_deal'
        ) AS ok
      `),
  },
  {
    key: 'closer',
    name: 'Closer',
    description: 'Close your first deal as a win.',
    icon: '🏆',
    category: 'deals',
    xpReward: 500,
    predicate: () =>
      existsRow(sql`
        SELECT EXISTS(
          SELECT 1 FROM deal_retrospectives
          WHERE deal_outcome = 'won' AND completed_at IS NOT NULL
        ) AS ok
      `),
  },
  {
    key: 'ten_in_the_book',
    name: 'Ten in the Book',
    description: 'Submit retrospectives on 10 distinct deals.',
    icon: '📚',
    category: 'deals',
    xpReward: 500,
    predicate: () =>
      countAtLeast(
        sql`
          SELECT COUNT(DISTINCT deal_id)::int AS n
          FROM deal_retrospectives
          WHERE completed_at IS NOT NULL
        `,
        10,
      ),
  },
  {
    key: 'whale',
    name: 'Whale',
    description: 'A single deal with LC value ≥ $10M.',
    icon: '🐋',
    category: 'deals',
    xpReward: 1000,
    predicate: () =>
      existsRow(sql`
        SELECT EXISTS(
          SELECT 1 FROM fuel_deals WHERE lc_value_usd >= 10000000
        ) AS ok
      `),
  },

  // ── Discipline ──────────────────────────────────────────────────
  {
    key: 'first_reflection',
    name: 'First Reflection',
    description: 'Submit your first deal retrospective.',
    icon: '🪞',
    category: 'discipline',
    xpReward: 50,
    predicate: () =>
      existsRow(sql`
        SELECT EXISTS(
          SELECT 1 FROM deal_retrospectives WHERE completed_at IS NOT NULL
        ) AS ok
      `),
  },
  {
    key: 'steady_hand',
    name: 'Steady Hand',
    description: 'Submit 10 retrospectives.',
    icon: '✋',
    category: 'discipline',
    xpReward: 300,
    predicate: () =>
      countAtLeast(
        sql`
          SELECT COUNT(*)::int AS n
          FROM deal_retrospectives
          WHERE completed_at IS NOT NULL
        `,
        10,
      ),
  },
  {
    key: 'hot_streak',
    name: 'Hot Streak',
    description: 'Hit a 30-day daily-action streak.',
    icon: '🔥',
    category: 'discipline',
    xpReward: 500,
    predicate: async (userId) => (await getCurrentStreakDays(userId)) >= 30,
  },

  // ── ML training (Cole's add) ────────────────────────────────────
  {
    key: 'trainer',
    name: 'Trainer',
    description: 'Submit 50 feedback events lifetime.',
    icon: '🧠',
    category: 'ml',
    xpReward: 200,
    predicate: (userId) =>
      countAtLeast(
        sql`
          SELECT COUNT(*)::int AS n FROM feedback_events
          WHERE user_id = ${userId}
        `,
        50,
      ),
  },
  {
    key: 'annotator',
    name: 'Annotator',
    description: 'Resolve 25 entity mentions.',
    icon: '🔖',
    category: 'ml',
    xpReward: 300,
    predicate: () =>
      countAtLeast(
        sql`
          SELECT COUNT(*)::int AS n FROM extracted_entities
          WHERE resolved_entity_slug IS NOT NULL
        `,
        25,
      ),
  },
  {
    key: 'curator',
    name: 'Curator',
    description: 'Correct or confirm 25 entity attributes.',
    icon: '🧪',
    category: 'ml',
    xpReward: 300,
    predicate: (userId) =>
      countAtLeast(
        sql`
          SELECT COUNT(*)::int AS n FROM feedback_events
          WHERE user_id = ${userId} AND feedback_kind = 'entity_attribute'
        `,
        25,
      ),
  },

  // ── Meta ────────────────────────────────────────────────────────
  {
    key: 'veteran',
    name: 'Veteran',
    description: 'Reach Level 5 (Desk Lead).',
    icon: '🎖️',
    category: 'meta',
    xpReward: 200,
    predicate: async (userId) => {
      const totalRows = await db
        .select({ total: sql<number>`COALESCE(SUM(${xpLedger.points}), 0)::int` })
        .from(xpLedger)
        .where(eq(xpLedger.userId, userId));
      const total = Number(totalRows[0]?.total ?? 0);
      return levelFromXp(total).level >= 5;
    },
  },
];

export interface AchievementWithState extends AchievementDefinition {
  unlocked: boolean;
  earnedAt: Date | null;
}

/**
 * Pure read — returns every achievement annotated with its unlock
 * state for the user. No side effects. Powers the /achievements
 * grid render.
 */
export async function listAchievementsForUser(
  userId: string,
): Promise<AchievementWithState[]> {
  const rows = await db
    .select({
      key: achievementsEarned.achievementKey,
      earnedAt: achievementsEarned.earnedAt,
    })
    .from(achievementsEarned)
    .where(eq(achievementsEarned.userId, userId));
  const earned = new Map<string, Date>();
  for (const r of rows) earned.set(r.key, r.earnedAt);
  return ACHIEVEMENT_REGISTRY.map((a) => ({
    ...a,
    unlocked: earned.has(a.key),
    earnedAt: earned.get(a.key) ?? null,
  }));
}

export interface EvaluateSummary {
  evaluated: number;
  unlocked: string[];
}

/**
 * Run every locked achievement's predicate; for any that return true,
 * insert into `achievements_earned` (idempotent on the unique
 * constraint) and award the XP. Fires
 * `gamification.achievement_unlocked` notifications for each new
 * unlock.
 *
 * Called after `awardXp` (fire-and-forget) so the post-action latency
 * doesn't block the caller. Also called from the backfill script
 * after historical XP is credited so old activity unlocks anything
 * it qualifies for.
 *
 * Errors are swallowed — never blocks the parent action.
 */
export async function evaluateAchievements(
  userId: string,
): Promise<EvaluateSummary> {
  try {
    // Pull already-unlocked keys to skip those predicates.
    const earnedRows = await db
      .select({ key: achievementsEarned.achievementKey })
      .from(achievementsEarned)
      .where(eq(achievementsEarned.userId, userId));
    const earnedKeys = new Set(earnedRows.map((r) => r.key));

    const candidates = ACHIEVEMENT_REGISTRY.filter(
      (a) => !earnedKeys.has(a.key),
    );
    if (candidates.length === 0) {
      return { evaluated: 0, unlocked: [] };
    }

    const results = await Promise.all(
      candidates.map(async (a) => {
        try {
          const passed = await a.predicate(userId);
          return { def: a, passed };
        } catch (err) {
          console.error('[gamification] predicate failed', a.key, err);
          return { def: a, passed: false };
        }
      }),
    );

    const unlocked: string[] = [];
    for (const { def, passed } of results) {
      if (!passed) continue;
      const inserted = await db
        .insert(achievementsEarned)
        .values({
          userId,
          achievementKey: def.key,
        })
        .onConflictDoNothing({
          target: [
            achievementsEarned.userId,
            achievementsEarned.achievementKey,
          ],
        })
        .returning({ id: achievementsEarned.id });
      if (inserted.length === 0) continue;
      unlocked.push(def.key);

      await awardXp({
        userId,
        sourceTable: 'achievement',
        sourceId: def.key,
        verb: `achievement.${def.key}`,
        points: def.xpReward,
        reason: `Achievement: ${def.name}`,
      });
      await fanoutAchievementNotification({ userId, achievement: def });
    }

    return { evaluated: candidates.length, unlocked };
  } catch (err) {
    console.error('[gamification] evaluateAchievements failed', err, {
      userId,
    });
    return { evaluated: 0, unlocked: [] };
  }
}

async function fanoutAchievementNotification(input: {
  userId: string;
  achievement: AchievementDefinition;
}): Promise<void> {
  try {
    const userRow = await db
      .select({ companyId: users.companyId })
      .from(users)
      .where(and(eq(users.id, input.userId), isNotNull(users.companyId)))
      .limit(1);
    const companyId = userRow[0]?.companyId ?? null;
    if (!companyId) return;
    await db.insert(notifications).values({
      userId: input.userId,
      companyId,
      type: 'gamification.achievement_unlocked',
      title: `${input.achievement.icon} Achievement unlocked — ${input.achievement.name}`,
      body: `${input.achievement.description} +${input.achievement.xpReward} XP`,
      link: '/achievements',
      entityType: null,
      entityId: null,
    });
  } catch (err) {
    console.error(
      '[gamification] achievement-unlock notification failed',
      err,
    );
  }
}

// Suppress unused-import lint on the row-type alias — re-exported
// for downstream pages that might want to render the raw earned-at
// timestamp without re-querying.
export type { AchievementEarnedRow };
