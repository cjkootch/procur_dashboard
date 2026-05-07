import 'server-only';
import { and, desc, eq, gte, sql } from 'drizzle-orm';
import {
  approvals,
  db,
  notifications,
  users,
  xpLedger,
} from '@procur/db';
import { isNotNull } from 'drizzle-orm';
import { awardXp } from './award';

/**
 * Daily quests — the home-page card that pulls Cole into doing the
 * chronically-skipped chores AND the ML labeling work. Slice 2 of
 * the gamification plan.
 *
 * Quest progress derives from SQL counts over today's events; no
 * `quest_progress` table. Completion writes to xp_ledger with
 * `source_table='quest'` and a per-day source_id so the same quest
 * can never double-credit on the same day. The unique partial
 * index on xp_ledger handles the idempotency.
 *
 * Three of the registered quests are picked per day, deterministically
 * by hash of (userId, dateISO), so refreshing the home page yields
 * the same trio. They roll over at UTC midnight.
 */

export type QuestCategory = 'workflow' | 'ml' | 'hygiene';

export interface QuestDefinition {
  key: string;
  title: string;
  description: string;
  category: QuestCategory;
  xpReward: number;
  target: number;
  /** When false, the quest sits out of rotation entirely (e.g. its
   *  underlying UI hasn't shipped yet). */
  enabled: boolean;
  /**
   * Count progress toward the target for the day window starting at
   * `dayStart` (UTC). Receives the operator's user id; predicates
   * that span tables without a clean user_id (events, messages) can
   * count org-wide for now — single-user lock-in.
   */
  countToday: (userId: string, dayStart: Date) => Promise<number>;
}

async function countSql(query: ReturnType<typeof sql>): Promise<number> {
  const rows = await db.execute<{ n: number }>(query);
  return Number(rows.rows[0]?.n ?? 0);
}

export const QUEST_REGISTRY: QuestDefinition[] = [
  {
    key: 'three_at_the_bell',
    title: 'Three at the Bell',
    description: 'Approve 3 pending outreach proposals before close.',
    category: 'workflow',
    xpReward: 15,
    target: 3,
    enabled: true,
    countToday: async (userId, dayStart) =>
      countSql(sql`
        SELECT COUNT(*)::int AS n
        FROM ${approvals}
        WHERE ${approvals.decision} = 'approved'
          AND ${approvals.reviewerId} = ${userId}
          AND ${approvals.appliedAt} >= ${dayStart}
      `),
  },
  {
    key: 'close_the_loop',
    title: 'Close the Loop',
    description: 'Disposition 5 stale outreach (replied / disqualified / no-response).',
    category: 'workflow',
    xpReward: 25,
    target: 5,
    enabled: true,
    countToday: async (_userId, dayStart) =>
      countSql(sql`
        SELECT COUNT(*)::int AS n
        FROM events
        WHERE verb IN (
          'outreach.replied',
          'outreach.disqualified',
          'outreach.no_response_7d'
        )
        AND occurred_at >= ${dayStart}
      `),
  },
  {
    key: 'mark_the_book',
    title: 'Mark the Book',
    description: 'Submit 1 deal retrospective OR record 1 KYC decision.',
    category: 'workflow',
    xpReward: 50,
    target: 1,
    enabled: true,
    countToday: async (userId, dayStart) =>
      countSql(sql`
        SELECT (
          (SELECT COUNT(*) FROM deal_retrospectives
             WHERE user_id = ${userId} AND completed_at >= ${dayStart})
          + (SELECT COUNT(*) FROM supplier_approvals
             WHERE created_by = ${userId}
               AND status IN ('approved_with_kyc','approved_without_kyc','rejected')
               AND updated_at >= ${dayStart})
        )::int AS n
      `),
  },
  {
    key: 'triage_run',
    title: 'Triage Run',
    description: 'Clear 5 match-queue items (favorite / dismiss / mute).',
    category: 'workflow',
    xpReward: 10,
    target: 5,
    enabled: true,
    countToday: async (userId, dayStart) =>
      countSql(sql`
        SELECT COUNT(*)::int AS n
        FROM feedback_events
        WHERE user_id = ${userId}
          AND feedback_kind = 'match_quality'
          AND created_at >= ${dayStart}
      `),
  },
  {
    key: 'cold_outreach',
    title: 'Cold Outreach',
    description: 'Send 3 outreach messages.',
    category: 'workflow',
    xpReward: 20,
    target: 3,
    enabled: true,
    countToday: async (_userId, dayStart) =>
      countSql(sql`
        SELECT COUNT(*)::int AS n
        FROM events
        WHERE verb = 'outreach.sent'
          AND occurred_at >= ${dayStart}
      `),
  },
  {
    key: 'inbox_zero',
    title: 'Inbox Zero',
    description: 'Reply to 3 inbox threads.',
    category: 'workflow',
    xpReward: 15,
    target: 3,
    enabled: true,
    countToday: async (_userId, dayStart) =>
      countSql(sql`
        SELECT COUNT(DISTINCT thread_id)::int AS n
        FROM messages
        WHERE direction = 'outbound'
          AND created_at >= ${dayStart}
      `),
  },
  {
    key: 'train_the_brain',
    title: 'Train the Brain',
    description: 'Capture 5 feedback events of any kind today.',
    category: 'ml',
    xpReward: 25,
    target: 5,
    enabled: true,
    countToday: async (userId, dayStart) =>
      countSql(sql`
        SELECT COUNT(*)::int AS n
        FROM feedback_events
        WHERE user_id = ${userId}
          AND created_at >= ${dayStart}
      `),
  },
  {
    key: 'resolve_three',
    title: 'Resolve Three',
    description: 'Resolve 3 unresolved entity mentions today.',
    category: 'ml',
    xpReward: 20,
    target: 3,
    enabled: false, // gated on the mention-resolution UI shipping
    countToday: async (_userId, dayStart) =>
      countSql(sql`
        SELECT COUNT(*)::int AS n
        FROM extracted_entities
        WHERE resolved_entity_slug IS NOT NULL
          AND updated_at >= ${dayStart}
      `),
  },
  {
    key: 'curator',
    title: 'Curator',
    description: 'Correct or confirm 3 entity attributes today.',
    category: 'ml',
    xpReward: 20,
    target: 3,
    enabled: true,
    countToday: async (userId, dayStart) =>
      countSql(sql`
        SELECT COUNT(*)::int AS n
        FROM feedback_events
        WHERE user_id = ${userId}
          AND feedback_kind = 'entity_attribute'
          AND created_at >= ${dayStart}
      `),
  },
  {
    key: 'friction_logged',
    title: 'Friction Logged',
    description: 'File 1 friction note today.',
    category: 'hygiene',
    xpReward: 15,
    target: 1,
    enabled: true,
    countToday: async (userId, dayStart) =>
      countSql(sql`
        SELECT COUNT(*)::int AS n
        FROM feedback_events
        WHERE user_id = ${userId}
          AND feedback_kind = 'friction'
          AND created_at >= ${dayStart}
      `),
  },
];

export interface DailyQuest {
  key: string;
  title: string;
  description: string;
  category: QuestCategory;
  xpReward: number;
  target: number;
  count: number;
  complete: boolean;
  /** When the quest was first marked complete today (xp_ledger row's
   *  occurredAt). null until the count crosses the target. */
  completedAt: Date | null;
}

/**
 * Returns the 3 quests selected for the user today, with each
 * quest's current progress, completion state, and (if applicable)
 * the timestamp at which it crossed its target. Side effect: when
 * a quest crosses its target during this call, an XP-credit ledger
 * row + a `gamification.quest_complete` notification fan-out fire.
 *
 * Idempotent — calling getDailyQuests repeatedly never re-credits a
 * quest. The unique partial index on xp_ledger
 * (source_table, source_id, verb) handles re-entrancy.
 */
export async function getDailyQuests(userId: string): Promise<DailyQuest[]> {
  const dateISO = currentDayIsoUtc();
  const dayStart = startOfDayUtc();
  const selected = pickDailyQuests(userId, dateISO);

  return Promise.all(
    selected.map((q) => evaluateQuest(q, userId, dateISO, dayStart)),
  );
}

async function evaluateQuest(
  q: QuestDefinition,
  userId: string,
  dateISO: string,
  dayStart: Date,
): Promise<DailyQuest> {
  const count = await q.countToday(userId, dayStart);
  const complete = count >= q.target;
  const sourceId = `${userId}:${dateISO}:${q.key}`;
  const verb = `quest.${q.key}`;

  // Already credited? Pull occurredAt for the UI's "completed at" stamp.
  const existing = await db
    .select({ occurredAt: xpLedger.occurredAt })
    .from(xpLedger)
    .where(
      and(
        eq(xpLedger.sourceTable, 'quest'),
        eq(xpLedger.sourceId, sourceId),
        eq(xpLedger.verb, verb),
      ),
    )
    .limit(1);
  let completedAt = existing[0]?.occurredAt ?? null;

  if (complete && !completedAt) {
    const result = await awardXp({
      userId,
      sourceTable: 'quest',
      sourceId,
      verb,
      points: q.xpReward,
      reason: `Quest: ${q.title}`,
    });
    if (result.awarded) {
      completedAt = new Date();
      await fanoutQuestCompleteNotification({ userId, quest: q });
    }
  }

  return {
    key: q.key,
    title: q.title,
    description: q.description,
    category: q.category,
    xpReward: q.xpReward,
    target: q.target,
    count,
    complete,
    completedAt,
  };
}

async function fanoutQuestCompleteNotification(input: {
  userId: string;
  quest: QuestDefinition;
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
      type: 'gamification.quest_complete',
      title: `Quest complete — ${input.quest.title}`,
      body: `+${input.quest.xpReward} XP`,
      link: '/quests',
      entityType: null,
      entityId: null,
    });
  } catch (err) {
    console.error('[gamification] quest-complete notification failed', err);
  }
}

/**
 * Deterministic daily selection. Hash (userId, dateISO) into a 32-bit
 * seed; use it to permute the enabled-quest list and take the first
 * three. Returns fewer than 3 only when the registry has fewer than
 * 3 enabled quests (edge case for early-stage rollout).
 */
function pickDailyQuests(
  userId: string,
  dateISO: string,
): QuestDefinition[] {
  const pool = QUEST_REGISTRY.filter((q) => q.enabled);
  if (pool.length <= 3) return pool;
  const seed = stringHash32(`${userId}:${dateISO}`);
  const indexed = pool.map((q, i) => ({
    q,
    sort: stringHash32(`${seed}:${i}:${q.key}`),
  }));
  indexed.sort((a, b) => a.sort - b.sort);
  return indexed.slice(0, 3).map((x) => x.q);
}

function stringHash32(input: string): number {
  // FNV-1a 32-bit. Deterministic across deploys; fine for shuffling.
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function startOfDayUtc(): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

function currentDayIsoUtc(): string {
  return startOfDayUtc().toISOString().slice(0, 10);
}

export interface QuestHistoryDay {
  dateIso: string;
  questsCompleted: number;
  totalQuestXp: number;
  completedKeys: string[];
}

/**
 * Last `days` days of quest completion history (today + the prior
 * `days-1` calendar days). Powers the /quests history table.
 */
export async function listQuestHistory(
  userId: string,
  days = 7,
): Promise<QuestHistoryDay[]> {
  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - (days - 1));
  cutoff.setUTCHours(0, 0, 0, 0);

  const rows = await db
    .select({
      verb: xpLedger.verb,
      points: xpLedger.points,
      occurredAt: xpLedger.occurredAt,
    })
    .from(xpLedger)
    .where(
      and(
        eq(xpLedger.userId, userId),
        sql`${xpLedger.sourceTable} = 'quest'`,
        gte(xpLedger.occurredAt, cutoff),
      ),
    )
    .orderBy(desc(xpLedger.occurredAt));

  const byDay = new Map<string, QuestHistoryDay>();
  for (const r of rows) {
    const dateIso = r.occurredAt.toISOString().slice(0, 10);
    let entry = byDay.get(dateIso);
    if (!entry) {
      entry = {
        dateIso,
        questsCompleted: 0,
        totalQuestXp: 0,
        completedKeys: [],
      };
      byDay.set(dateIso, entry);
    }
    entry.questsCompleted += 1;
    entry.totalQuestXp += r.points;
    entry.completedKeys.push(r.verb.replace(/^quest\./, ''));
  }

  return Array.from(byDay.values()).sort((a, b) =>
    a.dateIso < b.dateIso ? 1 : -1,
  );
}
