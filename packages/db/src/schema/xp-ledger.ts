import { pgTable, uuid, text, integer, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './users';

/**
 * Append-only XP ledger powering the gamification layer (migration
 * 0092). One row per credited action — `awardXp()` writes here from
 * inside every event-emit site that maps to an XP rule. Read-time
 * aggregation (SUM(points), DISTINCT day count) drives the topbar
 * chip's level + streak with no cache layer.
 *
 * Idempotency: rows derived from external sources (feedback_events,
 * extracted_entities, deal_retrospectives, supplier_approvals)
 * carry `(source_table, source_id)` and a unique partial index
 * prevents the backfill scanner from double-crediting on re-run.
 * Quest completes / achievement awards / manual adjustments leave
 * those columns null and don't participate in the uniqueness check.
 */
export const xpLedger = pgTable(
  'xp_ledger',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** events.id when applicable; null for quest completes / achievements / manual. */
    eventId: uuid('event_id'),
    /** Polymorphic source pointer for non-events sources. */
    sourceTable: text('source_table'),
    sourceId: text('source_id'),
    /** Verb taxonomy: outreach.*, feedback.*, mention.*, kyc.*, quest.*, achievement.*, manual.*. */
    verb: text('verb').notNull(),
    points: integer('points').notNull(),
    /** Free-text label surfaced in the XP toast. */
    reason: text('reason').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    userOccurredIdx: index('xp_ledger_user_occurred_idx').on(
      table.userId,
      table.occurredAt,
    ),
    eventIdIdx: index('xp_ledger_event_id_idx').on(table.eventId),
    sourceVerbUniq: uniqueIndex('xp_ledger_source_verb_uniq_idx')
      .on(table.sourceTable, table.sourceId, table.verb)
      .where(sql`source_table IS NOT NULL AND source_id IS NOT NULL`),
  }),
);

export type XpLedgerRow = typeof xpLedger.$inferSelect;
export type NewXpLedgerRow = typeof xpLedger.$inferInsert;
