import {
  pgTable,
  uuid,
  text,
  date,
  timestamp,
  numeric,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { knownEntities } from './known-entities';
import { externalSuppliers } from './external-suppliers';
import { companies } from './companies';

/**
 * Match queue — ranked counterparty signals the trader should
 * action on each day. Capstone of the strategic-vision.md loop;
 * see migration 0050 for the original rationale and 0051 for the
 * per-tenant scoping.
 *
 * Each row is owned by exactly one company. The scoring cron loops
 * over companies and writes a tenant-scoped copy of each matching
 * source signal — same source row may produce N match_queue rows
 * (one per interested tenant), each with that tenant's preferred
 * categories / jurisdictions baked into the rationale and score.
 */
export const matchQueue = pgTable(
  'match_queue',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /** Owning tenant. Rows are deleted when the company is deleted. */
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),

    /** 'distress_event' | 'velocity_drop' | 'new_award'. */
    signalType: text('signal_type').notNull(),
    /** Specific event class — 'sec_filing_force_majeure',
        'press_distress_signal', 'bankruptcy_filing', etc. */
    signalKind: text('signal_kind').notNull(),

    /** Which procur table the source row lives in
        ('entity_news_events' | 'awards' | 'supplier_capability_summary'). */
    sourceTable: text('source_table').notNull(),
    /** Source row ID — for the re-fetch + dedupe path. UUID-as-text
        because awards.id is a uuid but supplier_capability_summary
        keys on supplier_id; uniform string keeps the dedup index
        simple. */
    sourceId: text('source_id').notNull(),

    knownEntityId: uuid('known_entity_id').references(() => knownEntities.id, {
      onDelete: 'set null',
    }),
    externalSupplierId: uuid('external_supplier_id').references(
      () => externalSuppliers.id,
      { onDelete: 'set null' },
    ),
    sourceEntityName: text('source_entity_name').notNull(),
    sourceEntityCountry: text('source_entity_country'),

    categoryTags: text('category_tags').array(),
    observedAt: date('observed_at').notNull(),

    /** 0.00–9.99, higher = more interesting. */
    score: numeric('score', { precision: 4, scale: 2 }).notNull(),
    rationale: text('rationale').notNull(),

    /** 'open' | 'dismissed' | 'pushed-to-vex' | 'actioned'. */
    status: text('status').notNull().default('open'),
    statusUpdatedAt: timestamp('status_updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),

    matchedAt: timestamp('matched_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    openScoreIdx: index('match_queue_open_score_idx').on(
      table.companyId,
      table.status,
      table.score,
      table.observedAt,
    ),
    observedIdx: index('match_queue_observed_idx').on(table.observedAt),
    dedupIdx: uniqueIndex('match_queue_dedup_idx').on(
      table.companyId,
      table.sourceTable,
      table.sourceId,
    ),
  }),
);

export type MatchQueueRow = typeof matchQueue.$inferSelect;
export type NewMatchQueueRow = typeof matchQueue.$inferInsert;
