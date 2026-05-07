/**
 * Gamification public surface — Slice 1 (foundation).
 *
 * Slice 2 (quests) and Slice 3 (achievements) will add quests.ts and
 * achievements.ts under this folder; this index will re-export them
 * when they ship.
 */
export { LEVEL_LADDER, levelFromXp, type LevelInfo } from './levels';
export {
  FIRST_OF_DAY_BONUS,
  streakMultiplier,
  xpRuleFor,
  type XpRule,
} from './xp-rules';
export { getCurrentStreakDays, getLongestStreakDays } from './streak';
export { getXpProgress, type XpProgress } from './progress';
export { awardXp, type AwardXpInput, type AwardXpResult } from './award';
export {
  backfillGamificationLedger,
  type BackfillSummary,
} from './backfill';
export {
  QUEST_REGISTRY,
  getDailyQuests,
  listQuestHistory,
  type QuestDefinition,
  type QuestCategory,
  type DailyQuest,
  type QuestHistoryDay,
} from './quests';
