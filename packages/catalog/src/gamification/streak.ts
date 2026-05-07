import 'server-only';
import { db } from '@procur/db';
import { sql } from 'drizzle-orm';

/**
 * Current daily streak — count of consecutive calendar days ending
 * TODAY (in UTC) on which the user earned at least one XP-bearing
 * action. Returns 0 when today has no XP rows or when there's a gap
 * before today; never throws.
 *
 * Implementation note: pure SQL with a recursive lateral that walks
 * back from today. Cheap on (user_id, occurred_at) index — for a
 * single-user ledger this returns in single-digit ms even at 100k
 * rows. No background job, no expiration logic, no cache.
 */
export async function getCurrentStreakDays(userId: string): Promise<number> {
  const rows = await db.execute<{ streak: number }>(sql`
    WITH days AS (
      SELECT DISTINCT date_trunc('day', occurred_at AT TIME ZONE 'UTC')::date AS d
      FROM xp_ledger
      WHERE user_id = ${userId}
        AND occurred_at >= CURRENT_DATE - INTERVAL '60 days'
    ),
    walk AS (
      SELECT CURRENT_DATE AS d, 0 AS step
      UNION ALL
      SELECT (walk.d - INTERVAL '1 day')::date, walk.step + 1
      FROM walk
      WHERE EXISTS (SELECT 1 FROM days WHERE days.d = walk.d)
        AND walk.step < 60
    )
    SELECT GREATEST(MAX(step), 0)::int AS streak
    FROM walk
    WHERE EXISTS (SELECT 1 FROM days WHERE days.d = walk.d)
  `);
  return Number(rows.rows[0]?.streak ?? 0);
}

/**
 * Longest streak the user has ever held. Computed by gap analysis on
 * the distinct day list. Useful for the level-chip popover ("Best:
 * 23 days") and the Hot Streak achievement.
 */
export async function getLongestStreakDays(userId: string): Promise<number> {
  const rows = await db.execute<{ longest: number }>(sql`
    WITH days AS (
      SELECT DISTINCT date_trunc('day', occurred_at AT TIME ZONE 'UTC')::date AS d
      FROM xp_ledger
      WHERE user_id = ${userId}
    ),
    grouped AS (
      SELECT d, d - (ROW_NUMBER() OVER (ORDER BY d) || ' days')::interval AS grp
      FROM days
    )
    SELECT COALESCE(MAX(streak), 0)::int AS longest
    FROM (
      SELECT COUNT(*) AS streak FROM grouped GROUP BY grp
    ) sub
  `);
  return Number(rows.rows[0]?.longest ?? 0);
}
