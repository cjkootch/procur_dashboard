/**
 * Trader-themed level ladder. Single source of truth — both
 * `levelFromXp()` and the LevelChip popover read this list.
 *
 * Curve roughly doubles each level. Lvl 10 (Partner) is reachable
 * but aspirational at single-user activity volume; raise the cap
 * if Cole hits it before we can add more rungs.
 */
export const LEVEL_LADDER = [
  { level: 1, name: 'Runner', minXp: 0 },
  { level: 2, name: 'Junior Broker', minXp: 200 },
  { level: 3, name: 'Broker', minXp: 500 },
  { level: 4, name: 'Senior Broker', minXp: 1_000 },
  { level: 5, name: 'Desk Lead', minXp: 2_000 },
  { level: 6, name: 'Book Runner', minXp: 4_000 },
  { level: 7, name: 'Trader', minXp: 8_000 },
  { level: 8, name: 'Senior Trader', minXp: 15_000 },
  { level: 9, name: 'Head of Desk', minXp: 28_000 },
  { level: 10, name: 'Partner', minXp: 50_000 },
] as const;

export interface LevelInfo {
  level: number;
  name: string;
  minXp: number;
  /** XP threshold for the next level, or null if at the top. */
  nextLevelMinXp: number | null;
}

interface LevelRung {
  level: number;
  name: string;
  minXp: number;
}

/**
 * Resolve total XP to a level. Returns the highest rung whose
 * `minXp` is <= the input. Always returns level 1 for non-negative
 * input — the floor is "Runner".
 */
export function levelFromXp(totalXp: number): LevelInfo {
  let chosen: LevelRung = LEVEL_LADDER[0]!;
  for (const rung of LEVEL_LADDER) {
    if (totalXp >= rung.minXp) chosen = rung;
    else break;
  }
  const nextIdx = LEVEL_LADDER.findIndex((r) => r.level === chosen.level + 1);
  const next: LevelRung | null = nextIdx >= 0 ? LEVEL_LADDER[nextIdx]! : null;
  return {
    level: chosen.level,
    name: chosen.name,
    minXp: chosen.minXp,
    nextLevelMinXp: next ? next.minXp : null,
  };
}
