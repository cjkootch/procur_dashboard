import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  boolean,
  index,
  unique,
} from 'drizzle-orm/pg-core';

/**
 * Pattern 5 (deal retrospectives) per
 * docs/feedback-ui-brief.md §8. Structured 5-7-minute retrospective
 * filled out 7+ days after a vex deal closes. Powers similar-deal
 * surfacing once Component A embeddings are populated.
 *
 * deal_id is text (not FK) — vex deals live in vex's database;
 * procur references them via vex's external id.
 */
export const dealRetrospectives = pgTable(
  'deal_retrospectives',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    dealId: text('deal_id').notNull(),
    userId: text('user_id').notNull(),
    /** 'won' | 'lost' | 'dead' at the time the retrospective was generated. */
    dealOutcome: text('deal_outcome').notNull(),

    initialSignalSource: text('initial_signal_source'),
    daysSignalToClose: integer('days_signal_to_close'),
    criticalMoments: text('critical_moments'),
    /** 'yes_materially' | 'yes_marginally' | 'no' | 'na'. */
    procurInsightMattered: text('procur_insight_mattered'),
    whatWouldHaveHelped: text('what_would_have_helped'),
    patternForFuture: text('pattern_for_future'),

    completedAt: timestamp('completed_at'),
    isDraft: boolean('is_draft').default(false).notNull(),

    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => ({
    dealIdx: index('deal_retrospectives_deal_idx').on(table.dealId),
    userIdx: index('deal_retrospectives_user_idx').on(table.userId),
    completedIdx: index('deal_retrospectives_completed_idx').on(table.completedAt),
    uniqByDealUser: unique().on(table.dealId, table.userId),
  }),
);

export type DealRetrospective = typeof dealRetrospectives.$inferSelect;
export type NewDealRetrospective = typeof dealRetrospectives.$inferInsert;
