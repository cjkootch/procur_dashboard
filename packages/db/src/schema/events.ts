import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

/**
 * Per docs/vex-into-procur-merge-brief.md Phase 2/3. Domain-event
 * audit log — actor + verb + subject + object. RANGE-partitioned by
 * `occurred_at` in the migration. `idempotency_key` collapses
 * duplicate event submissions; the unique index lives on
 * (occurred_at, idempotency_key) to play nicely with partition pruning.
 */
export const events = pgTable(
  'events',
  {
    id: text('id').notNull(),
    verb: text('verb').notNull(),
    subjectType: text('subject_type').notNull(),
    subjectId: text('subject_id').notNull(),
    actorType: text('actor_type'),
    actorId: text('actor_id'),
    objectType: text('object_type'),
    objectId: text('object_id'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    metadata: jsonb('metadata')
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
  },
  (t) => ({
    occurredAtIdx: index('events_occurred_at_idx').on(t.occurredAt),
    subjectIdx: index('events_subject_idx').on(t.subjectType, t.subjectId),
    idempotencyUniq: uniqueIndex('events_idempotency_uniq').on(
      t.occurredAt,
      t.idempotencyKey,
    ),
  }),
);

export type Event = typeof events.$inferSelect;
export type NewEvent = typeof events.$inferInsert;
