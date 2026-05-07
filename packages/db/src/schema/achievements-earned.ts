import { pgTable, uuid, text, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { users } from './users';

/**
 * Per-user record of unlocked achievements (migration 0092). One row
 * per (user, achievement_key); the unique index makes the unlock
 * idempotent — re-evaluating predicates after the first unlock is a
 * no-op. The achievement registry itself is code-as-config in
 * packages/catalog/src/gamification/achievements.ts; only the
 * earned state is persisted here.
 */
export const achievementsEarned = pgTable(
  'achievements_earned',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Stable key from ACHIEVEMENT_REGISTRY (e.g. 'first_light', 'first_fill'). */
    achievementKey: text('achievement_key').notNull(),
    earnedAt: timestamp('earned_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** Optional events.id (ULID/text) pointer to the action that triggered the unlock. */
    eventId: text('event_id'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    userKeyUniq: uniqueIndex('achievements_earned_user_key_uniq_idx').on(
      table.userId,
      table.achievementKey,
    ),
    userEarnedIdx: index('achievements_earned_user_earned_idx').on(
      table.userId,
      table.earnedAt,
    ),
  }),
);

export type AchievementEarnedRow = typeof achievementsEarned.$inferSelect;
export type NewAchievementEarnedRow = typeof achievementsEarned.$inferInsert;
