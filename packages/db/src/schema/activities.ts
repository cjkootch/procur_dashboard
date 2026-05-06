import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

/**
 * Per docs/vex-into-procur-merge-brief.md Phase 3. CRM-style activity
 * log — calls, meetings, notes — keyed off (type, related_object_ids).
 * Distinct from `events` (immutable domain events) — activities are
 * operator-authored and editable; events are system-generated.
 */
export const activities = pgTable(
  'activities',
  {
    id: text('id').primaryKey(),
    type: text('type').notNull(),
    relatedObjectIds: jsonb('related_object_ids')
      .$type<Record<string, string>>()
      .notNull()
      .default({}),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    result: text('result'),
    transcriptRef: text('transcript_ref'),
    durationSeconds: integer('duration_seconds'),
    metadata: jsonb('metadata')
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    occurredAtIdx: index('activities_occurred_at_idx').on(t.occurredAt),
    typeIdx: index('activities_type_idx').on(t.type),
  }),
);

export type Activity = typeof activities.$inferSelect;
export type NewActivity = typeof activities.$inferInsert;
