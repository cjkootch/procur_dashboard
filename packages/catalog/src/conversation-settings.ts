import 'server-only';
import { and, eq } from 'drizzle-orm';
import {
  conversationSettings,
  db,
  type ConversationApprovalMode,
  type ConversationAuthority,
  type ConversationChannel,
  type ConversationIdentityDisclosure,
  type ConversationObjective,
  type ConversationSettings,
  type ConversationTone,
  type NewConversationSettings,
} from '@procur/db';

/**
 * Per-conversation agent settings — read/write helpers backing the
 * right-rail panel on /messages and /inbox. Slice 1 of the
 * conversation-agent system.
 *
 * Channel-specific defaults are layered HERE (not in the DB) so we
 * can evolve the defaults without a migration. Operator-set values
 * stick; everything else falls back to the channel default at read
 * time.
 *
 * Discipline: settings are operator-controlled. The agent runtime
 * (Slices 2 + 3) reads them but never writes them. Only the
 * settings panel + the runtime's mutable counters
 * (total_turns / total_cost_usd_micros / paused_at) write here.
 */

export interface ChannelDefaults {
  responseDelayMinSec: number;
  responseDelayMaxSec: number;
  followUpLadderHours: number[];
  quietHoursStartLocal: number | null;
  quietHoursEndLocal: number | null;
  maxTurns: number;
  maxCostUsdCents: number;
  maxDurationHours: number;
  identityDisclosure: ConversationIdentityDisclosure;
  channelConfig: Record<string, unknown>;
}

/**
 * Per-channel sane defaults. Source of truth for "what does a fresh
 * conversation look like?" The settings panel pre-fills from these
 * when the operator first enables AI on a conversation.
 */
const CHANNEL_DEFAULTS: Record<ConversationChannel, ChannelDefaults> = {
  sms: {
    responseDelayMinSec: 30,
    responseDelayMaxSec: 90,
    followUpLadderHours: [2, 24, 72],
    quietHoursStartLocal: 20,
    quietHoursEndLocal: 8,
    maxTurns: 8,
    maxCostUsdCents: 50,
    maxDurationHours: 24,
    identityDisclosure: 'on_request',
    channelConfig: {
      response_length_target: 'short',
      one_sentence_replies: true,
    },
  },
  whatsapp: {
    responseDelayMinSec: 30,
    responseDelayMaxSec: 90,
    followUpLadderHours: [2, 24, 72],
    quietHoursStartLocal: 20,
    quietHoursEndLocal: 8,
    maxTurns: 8,
    maxCostUsdCents: 50,
    maxDurationHours: 24,
    // LATAM/Caribbean recipients often expect transparency; default
    // to always-disclose for WhatsApp.
    identityDisclosure: 'always',
    channelConfig: {
      response_length_target: 'short',
      // Free-form reply only valid inside Twilio's 24h conversation
      // window. Outside it, the agent must use a Meta-approved
      // Content Template (refuses to reply otherwise).
      session_window_hours: 24,
    },
  },
  email: {
    // Email is async — no human-feel-in delay needed; instant is
    // preferred. Quiet hours don't matter (recipient gets the email
    // when their client polls anyway).
    responseDelayMinSec: 0,
    responseDelayMaxSec: 0,
    followUpLadderHours: [24, 72, 168],
    quietHoursStartLocal: null,
    quietHoursEndLocal: null,
    // Email threads run long; agent budget is tighter than SMS.
    maxTurns: 6,
    maxCostUsdCents: 100,
    maxDurationHours: 168, // 1 week
    identityDisclosure: 'on_request',
    channelConfig: {
      response_length_target: 'medium',
      reply_mode: 'reply_to_from', // 'reply_to_from' | 'reply_all' | 'reply_with_original_cc'
      subject_strategy: 'preserve_re_chain', // 'preserve_re_chain' | 'allow_subject_evolution'
      attachment_policy: 'require_approval', // 'never' | 'whitelist' | 'require_approval'
      ooo_auto_pause: true,
      append_unsubscribe: false, // off by default; jurisdiction-specific
    },
  },
};

export function getChannelDefaults(channel: ConversationChannel): ChannelDefaults {
  return CHANNEL_DEFAULTS[channel];
}

/**
 * Read settings for a conversation. Returns null when no settings
 * exist — caller renders an "AI off" placeholder. Use
 * `getOrInitConversationSettings` when the operator clicks
 * "Configure" to materialize a row with channel defaults.
 */
export async function getConversationSettings(input: {
  channel: ConversationChannel;
  conversationKey: string;
}): Promise<ConversationSettings | null> {
  const [row] = await db
    .select()
    .from(conversationSettings)
    .where(
      and(
        eq(conversationSettings.channel, input.channel),
        eq(conversationSettings.conversationKey, input.conversationKey),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Read settings; if absent, insert a row pre-populated with channel
 * defaults and return it. Idempotent — re-running on an existing
 * conversation returns the existing row unchanged.
 */
export async function getOrInitConversationSettings(input: {
  channel: ConversationChannel;
  conversationKey: string;
  createdByUserId?: string | null;
}): Promise<ConversationSettings> {
  const existing = await getConversationSettings(input);
  if (existing) return existing;

  const defaults = CHANNEL_DEFAULTS[input.channel];
  const row: NewConversationSettings = {
    channel: input.channel,
    conversationKey: input.conversationKey,
    aiEnabled: false,
    authority: 'chitchat_only',
    approvalMode: 'full_approval',
    tone: 'brokerage_direct',
    language: 'auto',
    identityDisclosure: defaults.identityDisclosure,
    responseDelayMinSec: defaults.responseDelayMinSec,
    responseDelayMaxSec: defaults.responseDelayMaxSec,
    followUpLadderHours: defaults.followUpLadderHours,
    quietHoursStartLocal: defaults.quietHoursStartLocal,
    quietHoursEndLocal: defaults.quietHoursEndLocal,
    maxTurns: defaults.maxTurns,
    maxCostUsdCents: defaults.maxCostUsdCents,
    maxDurationHours: defaults.maxDurationHours,
    channelConfig: defaults.channelConfig,
    createdByUserId: input.createdByUserId ?? null,
  };
  const [inserted] = await db
    .insert(conversationSettings)
    .values(row)
    .onConflictDoNothing({
      target: [
        conversationSettings.channel,
        conversationSettings.conversationKey,
      ],
    })
    .returning();
  if (inserted) return inserted;

  // Race: someone else inserted between our select and our insert.
  // Re-read.
  const second = await getConversationSettings(input);
  if (!second) throw new Error('conversation_settings race — no row after insert');
  return second;
}

export interface ConversationSettingsPatch {
  aiEnabled?: boolean;
  authority?: ConversationAuthority;
  approvalMode?: ConversationApprovalMode;
  objective?: ConversationObjective | null;
  customPrompt?: string | null;
  tone?: ConversationTone;
  language?: string;
  identityDisclosure?: ConversationIdentityDisclosure;
  linkedLeadId?: string | null;
  linkedDealId?: string | null;
  linkedEntitySlug?: string | null;
  responseDelayMinSec?: number;
  responseDelayMaxSec?: number;
  followUpLadderHours?: number[];
  quietHoursStartLocal?: number | null;
  quietHoursEndLocal?: number | null;
  recipientTimezone?: string | null;
  maxTurns?: number;
  maxCostUsdCents?: number;
  maxDurationHours?: number;
  stopKeywords?: string[];
  handoffTriggers?: Record<string, unknown>;
  channelConfig?: Record<string, unknown>;
  pausedAt?: Date | null;
  pausedReason?: string | null;
}

/**
 * Apply a partial update to an existing conversation's settings.
 * Caller must pass the conversation identifiers; the patch only
 * overwrites fields that are present.
 */
export async function updateConversationSettings(input: {
  channel: ConversationChannel;
  conversationKey: string;
  patch: ConversationSettingsPatch;
}): Promise<ConversationSettings | null> {
  const set: Record<string, unknown> = { updatedAt: new Date() };
  for (const [k, v] of Object.entries(input.patch)) {
    if (v !== undefined) set[k] = v;
  }
  if (Object.keys(set).length === 1) {
    // Only updatedAt — nothing to do.
    return getConversationSettings(input);
  }
  const [row] = await db
    .update(conversationSettings)
    .set(set)
    .where(
      and(
        eq(conversationSettings.channel, input.channel),
        eq(conversationSettings.conversationKey, input.conversationKey),
      ),
    )
    .returning();
  return row ?? null;
}
