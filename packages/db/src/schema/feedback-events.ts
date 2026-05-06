import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/**
 * Unified feedback events per docs/feedback-ui-brief.md §3.1.
 * Single table for all five patterns; pattern-specific data goes
 * in the JSONB payload column.
 *
 * Coexists with match_outcome_events (vex PR #309) — Pattern 1
 * writes to BOTH on match-queue actions per brief §3.2.
 */
export const feedbackEvents = pgTable(
  'feedback_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Clerk user id; nullable for system-attributed events. */
    userId: text('user_id'),
    /** 'match_quality' | 'entity_attribute' | 'friction' |
        'disposition' | 'retrospective'. Free text. */
    feedbackKind: text('feedback_kind').notNull(),
    /** 'match' | 'entity' | 'signal' | 'deal' | 'global'. */
    targetType: text('target_type'),
    /** ID of the target object — match.id, entity slug, deal id, etc. */
    targetId: text('target_id'),
    /** Compound reference — e.g. signal_source on a mute event. */
    targetSecondaryId: text('target_secondary_id'),
    /** Extracted from payload for indexability:
        'positive' | 'negative' | 'neutral' | 'mute' | 'pin'. */
    sentiment: text('sentiment'),
    payload: jsonb('payload').notNull().default(sql`'{}'::jsonb`),
    /** Auto-captured page / search / nav-path / current entity. */
    context: jsonb('context'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    /** Soft-delete for "actually I didn't mean that". */
    revokedAt: timestamp('revoked_at'),
  },
  (table) => ({
    userIdx: index('feedback_events_user_idx').on(table.userId),
    kindIdx: index('feedback_events_kind_idx').on(table.feedbackKind),
    targetIdx: index('feedback_events_target_idx').on(table.targetType, table.targetId),
    createdIdx: index('feedback_events_created_idx').on(table.createdAt),
    payloadIdx: index('feedback_events_payload_idx').using('gin', table.payload),
  }),
);

export type FeedbackEvent = typeof feedbackEvents.$inferSelect;
export type NewFeedbackEvent = typeof feedbackEvents.$inferInsert;

/**
 * Mute rules per Pattern 1. Structural — when user mutes from the
 * match queue, future rows matching the (user, entity, signal_type,
 * source) tuple are filtered server-side.
 */
export const signalMuteRules = pgTable(
  'signal_mute_rules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id').notNull(),
    /** known_entities.slug or external_suppliers.id (UUID). */
    entitySlug: text('entity_slug').notNull(),
    /** Signal type from match_queue.signal_type. */
    signalType: text('signal_type').notNull(),
    /** Optional source pin — null = "any source for this type". */
    signalSource: text('signal_source'),
    mutedAt: timestamp('muted_at').defaultNow().notNull(),
    /** NULL = indefinite. Brief §11 expiration policy ships indefinite. */
    mutedUntil: timestamp('muted_until'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => ({
    // Re-mute is a noop, not a duplicate row.
    uniqIdx: uniqueIndex('signal_mute_rules_uniq_idx').on(
      table.userId,
      table.entitySlug,
      table.signalType,
      sql`COALESCE(${table.signalSource}, '')`,
    ),
    userIdx: index('signal_mute_rules_user_idx').on(table.userId),
    entityIdx: index('signal_mute_rules_entity_idx').on(table.entitySlug),
  }),
);

export type SignalMuteRule = typeof signalMuteRules.$inferSelect;
export type NewSignalMuteRule = typeof signalMuteRules.$inferInsert;
