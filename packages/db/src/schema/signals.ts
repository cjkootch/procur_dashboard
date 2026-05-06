import { index, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * Per docs/vex-into-procur-merge-brief.md Phase 6. Proactive signal
 * layer — cron rules insert rows here to surface conditions operators
 * need to see without asking (laycan approaching without BIS, margin
 * threshold crossed, stale deal, overdue follow-up). Coexists with
 * procur's existing `alerts` table (user subscriptions); intents are
 * different — alerts are pull, signals are push.
 */
export const signals = pgTable(
  'signals',
  {
    id: text('id').primaryKey(),
    /** Stable machine id for the rule that fired. */
    ruleId: text('rule_id').notNull(),
    severity: text('severity').notNull().default('warn'),
    subjectType: text('subject_type'),
    subjectId: text('subject_id'),
    title: text('title').notNull(),
    body: text('body'),
    metadata: jsonb('metadata')
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true }),
    acknowledgedBy: text('acknowledged_by'),
  },
  (t) => ({
    createdAtIdx: index('signals_created_at_idx').on(t.createdAt),
    ruleIdx: index('signals_rule_idx').on(t.ruleId),
    subjectIdx: index('signals_subject_idx').on(t.subjectType, t.subjectId),
  }),
);

export type Signal = typeof signals.$inferSelect;
export type NewSignal = typeof signals.$inferInsert;
