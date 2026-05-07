import 'server-only';
import { db, xpLedger } from '@procur/db';
import { eq, sql } from 'drizzle-orm';
import { LEVEL_LADDER, levelFromXp } from './levels';
import { getCurrentStreakDays, getLongestStreakDays } from './streak';

export interface XpProgress {
  totalXp: number;
  level: number;
  levelName: string;
  /** XP earned within the current level (totalXp - currentLevel.minXp). */
  xpInLevel: number;
  /** XP needed to reach the next level, or null if at the cap. */
  xpToNextLevel: number | null;
  /** Total XP threshold for the current level. */
  currentLevelMinXp: number;
  /** Total XP threshold for the next level, or null if at the cap. */
  nextLevelMinXp: number | null;
  currentStreakDays: number;
  longestStreakDays: number;
}

/**
 * Aggregate state for the topbar chip. Single SQL roundtrip for the
 * total + a couple cheap queries for streak. No caching — designed
 * to be called on every authenticated page render.
 *
 * Returns a level-1 / 0-XP / 0-streak fallback when the user has no
 * ledger rows yet (clean cold-start UX before backfill runs).
 */
export async function getXpProgress(userId: string): Promise<XpProgress> {
  const totalRows = await db
    .select({ total: sql<number>`COALESCE(SUM(${xpLedger.points}), 0)::int` })
    .from(xpLedger)
    .where(eq(xpLedger.userId, userId));
  const totalXp = Number(totalRows[0]?.total ?? 0);

  const [currentStreakDays, longestStreakDays] = await Promise.all([
    getCurrentStreakDays(userId),
    getLongestStreakDays(userId),
  ]);

  const info = levelFromXp(totalXp);
  const xpInLevel = totalXp - info.minXp;
  const xpToNextLevel =
    info.nextLevelMinXp != null ? info.nextLevelMinXp - totalXp : null;

  return {
    totalXp,
    level: info.level,
    levelName: info.name,
    xpInLevel,
    xpToNextLevel,
    currentLevelMinXp: info.minXp,
    nextLevelMinXp: info.nextLevelMinXp,
    currentStreakDays,
    longestStreakDays,
  };
}

// Touch LEVEL_LADDER so the import isn't elided when LevelInfo's
// shape is the only thing this module re-exports through levelFromXp.
void LEVEL_LADDER;
