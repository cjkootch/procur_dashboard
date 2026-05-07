import {
  pgTable,
  uuid,
  text,
  boolean,
  integer,
  bigint,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/**
 * Per-conversation agent settings (migration 0090). Powers the
 * right-rail settings panel on /messages and /inbox. Slice 1 of the
 * conversation-agent system: storage + UI only. No agent automation
 * yet — AI is off by default. Slices 2 (sms/whatsapp) and 3 (email)
 * wire the inbound webhook → agent path.
 *
 * One row per (channel, conversation_key). Channel-specific defaults
 * are layered in the catalog helper, not here — the schema just
 * stores whatever the operator configured.
 */
export const conversationSettings = pgTable(
  'conversation_settings',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /** 'sms' | 'whatsapp' | 'email'. */
    channel: text('channel').notNull(),
    /** E.164 phone for sms/whatsapp; thread_id for email. */
    conversationKey: text('conversation_key').notNull(),

    aiEnabled: boolean('ai_enabled').notNull().default(false),
    /** 'chitchat_only' | 'ranges_only' | 'commit_with_approval'. */
    authority: text('authority').notNull().default('chitchat_only'),
    /** 'full_approval' | 'tiered' | 'business_hours_only'. */
    approvalMode: text('approval_mode').notNull().default('full_approval'),

    objective: text('objective'),
    customPrompt: text('custom_prompt'),
    handoffTriggers: jsonb('handoff_triggers')
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    stopKeywords: text('stop_keywords')
      .array()
      .notNull()
      .default(sql`ARRAY[]::text[]`),

    tone: text('tone').notNull().default('brokerage_direct'),
    language: text('language').notNull().default('auto'),
    identityDisclosure: text('identity_disclosure')
      .notNull()
      .default('on_request'),

    linkedLeadId: text('linked_lead_id'),
    linkedDealId: text('linked_deal_id'),
    linkedEntitySlug: text('linked_entity_slug'),

    responseDelayMinSec: integer('response_delay_min_sec').notNull().default(30),
    responseDelayMaxSec: integer('response_delay_max_sec').notNull().default(90),
    followUpLadderHours: integer('follow_up_ladder_hours')
      .array()
      .notNull()
      .default(sql`ARRAY[2, 24, 72]`),
    quietHoursStartLocal: integer('quiet_hours_start_local'),
    quietHoursEndLocal: integer('quiet_hours_end_local'),
    recipientTimezone: text('recipient_timezone'),

    maxTurns: integer('max_turns').notNull().default(8),
    maxCostUsdCents: integer('max_cost_usd_cents').notNull().default(50),
    maxDurationHours: integer('max_duration_hours').notNull().default(24),

    pausedAt: timestamp('paused_at', { withTimezone: true }),
    pausedReason: text('paused_reason'),
    totalTurns: integer('total_turns').notNull().default(0),
    totalCostUsdMicros: bigint('total_cost_usd_micros', { mode: 'number' })
      .notNull()
      .default(0),

    /** Email uses this for reply_to_all / subject_lock / signature_id /
     *  attachment_policy / response_length_target. SMS/WhatsApp
     *  typically leave it empty. */
    channelConfig: jsonb('channel_config')
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),

    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdByUserId: text('created_by_user_id'),
  },
  (table) => ({
    channelKeyUniq: uniqueIndex(
      'conversation_settings_channel_key_uniq_idx',
    ).on(table.channel, table.conversationKey),
    aiEnabledIdx: index('conversation_settings_ai_enabled_idx').on(
      table.aiEnabled,
    ),
  }),
);

export type ConversationSettings = typeof conversationSettings.$inferSelect;
export type NewConversationSettings = typeof conversationSettings.$inferInsert;

export const CONVERSATION_CHANNELS = ['sms', 'whatsapp', 'email'] as const;
export type ConversationChannel = (typeof CONVERSATION_CHANNELS)[number];

export const CONVERSATION_AUTHORITY_LEVELS = [
  'chitchat_only',
  'ranges_only',
  'commit_with_approval',
] as const;
export type ConversationAuthority = (typeof CONVERSATION_AUTHORITY_LEVELS)[number];

export const CONVERSATION_APPROVAL_MODES = [
  'full_approval',
  'tiered',
  'business_hours_only',
] as const;
export type ConversationApprovalMode = (typeof CONVERSATION_APPROVAL_MODES)[number];

export const CONVERSATION_OBJECTIVES = [
  'qualify',
  'book_meeting',
  'get_pricing',
  'support',
  'close_deal',
  'custom',
] as const;
export type ConversationObjective = (typeof CONVERSATION_OBJECTIVES)[number];

export const CONVERSATION_TONES = [
  'formal',
  'casual',
  'brokerage_direct',
] as const;
export type ConversationTone = (typeof CONVERSATION_TONES)[number];

export const CONVERSATION_IDENTITY_DISCLOSURES = [
  'always',
  'on_request',
  'never',
] as const;
export type ConversationIdentityDisclosure =
  (typeof CONVERSATION_IDENTITY_DISCLOSURES)[number];
