import { pgTable, uuid, text, timestamp, index } from 'drizzle-orm/pg-core';

/**
 * Pattern 4 (disposition tracking) per
 * docs/feedback-ui-brief.md §7. Append-only history of (user,
 * entity) commercial-pursuit state transitions. The latest non-
 * superseded row per (user, entity) is the current disposition.
 *
 * Distinct from supplier_approvals (KYC status) — disposition is
 * pursuit-state; approvals are KYC/contract gates.
 */
export const entityDispositions = pgTable(
  'entity_dispositions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    entitySlug: text('entity_slug').notNull(),
    userId: text('user_id').notNull(),
    /** 'active_pursuing' | 'active_exploratory' | 'dormant' | 'dead'
        | 'declined' | 'never_contacted'. Free text. */
    disposition: text('disposition').notNull(),
    /** Required when disposition='declined'. */
    declineReason: text('decline_reason'),
    setAt: timestamp('set_at').defaultNow().notNull(),
    /** Set when a newer row replaces this one. Current rows have
        superseded_at IS NULL. */
    supersededAt: timestamp('superseded_at'),
  },
  (table) => ({
    entityIdx: index('entity_dispositions_entity_idx').on(table.entitySlug),
    userIdx: index('entity_dispositions_user_idx').on(table.userId),
  }),
);

export type EntityDisposition = typeof entityDispositions.$inferSelect;
export type NewEntityDisposition = typeof entityDispositions.$inferInsert;
