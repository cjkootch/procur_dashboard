import { pgTable, uuid, text, timestamp, jsonb, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './users';

/**
 * Mission instances (migration 0094). Two flavors:
 *   - Registered (`kind='deal_lifecycle'`): stages come from
 *     MISSION_REGISTRY in catalog code; predicates auto-evaluate
 *     on the home page render hook.
 *   - Custom (`kind='custom'`): stages stored inline; complete
 *     manually via a server action.
 *
 * stage_completions maps stage_key → ISO ts. The UI render path
 * doesn't branch on kind for completion state — same shape.
 */
export const missionInstances = pgTable(
  'mission_instances',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** 'deal_lifecycle' | 'custom' (extensible) */
    kind: text('kind').notNull(),
    /** 'fuel_deal' for deal_lifecycle; null for custom */
    subjectType: text('subject_type'),
    /** fuel_deals.id (text/ULID) for deal_lifecycle; null for custom */
    subjectId: text('subject_id'),
    title: text('title').notNull(),
    description: text('description'),
    /** Inline stage list for custom missions:
     *  `[{ key, title, description?, xpReward, predicate: 'manual' }]`
     *  Null for registered missions. */
    customStages: jsonb('custom_stages').$type<CustomStageDef[] | null>(),
    /** 'active' | 'complete' | 'abandoned' */
    status: text('status').notNull().default('active'),
    /** Map of stage_key → ISO completion timestamp. */
    stageCompletions: jsonb('stage_completions')
      .$type<Record<string, string>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    abandonedAt: timestamp('abandoned_at', { withTimezone: true }),
    /** Approval id for chat-proposed custom missions. */
    approvalId: uuid('approval_id'),
  },
  (table) => ({
    userKindSubjectUniq: uniqueIndex(
      'mission_instances_user_kind_subject_uniq_idx',
    )
      .on(table.userId, table.kind, table.subjectId)
      .where(sql`subject_id IS NOT NULL`),
    userStatusIdx: index('mission_instances_user_status_idx').on(
      table.userId,
      table.status,
      table.createdAt,
    ),
    subjectIdx: index('mission_instances_subject_idx').on(
      table.subjectType,
      table.subjectId,
    ),
  }),
);

/** Custom-stage shape stored in mission_instances.custom_stages JSONB. */
export interface CustomStageDef {
  key: string;
  title: string;
  description?: string;
  xpReward: number;
  /** 'manual' for v1 — custom missions only support operator-marked
   *  completion. Future kinds (e.g. 'count_events') would let chat
   *  define automated predicates. */
  predicate: 'manual';
}

export type MissionInstanceRow = typeof missionInstances.$inferSelect;
export type NewMissionInstanceRow = typeof missionInstances.$inferInsert;
