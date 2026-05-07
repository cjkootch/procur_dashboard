import { NextResponse } from 'next/server';
import { z } from 'zod';
import {
  getOrInitConversationSettings,
  updateConversationSettings,
} from '@procur/catalog';
import { getCurrentUser } from '@procur/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Read + write conversation settings.
 *
 * GET  /api/conversation-settings?channel=sms&conversation_key=+1...
 *   → { settings } — initializes with channel defaults if none exist
 *
 * PATCH /api/conversation-settings
 *   body: { channel, conversation_key, patch: { ...partial } }
 *   → { settings: updated }
 */

const ChannelSchema = z.enum(['sms', 'whatsapp', 'email']);

const PatchSchema = z.object({
  channel: ChannelSchema,
  conversation_key: z.string().min(1).max(500),
  patch: z
    .object({
      aiEnabled: z.boolean().optional(),
      authority: z
        .enum(['chitchat_only', 'ranges_only', 'commit_with_approval'])
        .optional(),
      approvalMode: z
        .enum(['full_approval', 'tiered', 'business_hours_only'])
        .optional(),
      objective: z
        .enum([
          'qualify',
          'book_meeting',
          'get_pricing',
          'support',
          'close_deal',
          'custom',
        ])
        .nullable()
        .optional(),
      customPrompt: z.string().max(8000).nullable().optional(),
      tone: z.enum(['formal', 'casual', 'brokerage_direct']).optional(),
      language: z.string().max(10).optional(),
      identityDisclosure: z
        .enum(['always', 'on_request', 'never'])
        .optional(),
      linkedLeadId: z.string().max(200).nullable().optional(),
      linkedDealId: z.string().max(200).nullable().optional(),
      linkedEntitySlug: z.string().max(200).nullable().optional(),
      responseDelayMinSec: z.number().int().min(0).max(3600).optional(),
      responseDelayMaxSec: z.number().int().min(0).max(3600).optional(),
      followUpLadderHours: z
        .array(z.number().int().min(0).max(720))
        .max(10)
        .optional(),
      quietHoursStartLocal: z.number().int().min(0).max(23).nullable().optional(),
      quietHoursEndLocal: z.number().int().min(0).max(23).nullable().optional(),
      recipientTimezone: z.string().max(100).nullable().optional(),
      maxTurns: z.number().int().min(1).max(100).optional(),
      maxCostUsdCents: z.number().int().min(1).max(10_000).optional(),
      maxDurationHours: z.number().int().min(1).max(720).optional(),
      stopKeywords: z.array(z.string().max(50)).max(50).optional(),
      handoffTriggers: z.record(z.string(), z.unknown()).optional(),
      channelConfig: z.record(z.string(), z.unknown()).optional(),
      // Resume-from-paused: only `null` is accepted — operators clear
      // the pause but cannot fabricate a paused-at timestamp via the API.
      pausedAt: z.null().optional(),
      pausedReason: z.null().optional(),
    })
    .strict(),
});

export async function GET(req: Request): Promise<Response> {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const url = new URL(req.url);
  const channelParam = url.searchParams.get('channel');
  const conversationKey = url.searchParams.get('conversation_key');
  const channelParse = ChannelSchema.safeParse(channelParam);
  if (!channelParse.success || !conversationKey) {
    return NextResponse.json({ error: 'invalid_query' }, { status: 400 });
  }
  const settings = await getOrInitConversationSettings({
    channel: channelParse.data,
    conversationKey,
    createdByUserId: user.id,
  });
  return NextResponse.json({ settings });
}

export async function PATCH(req: Request): Promise<Response> {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const body = (await req.json().catch(() => null)) as unknown;
  const parsed = PatchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid_input', details: parsed.error.issues },
      { status: 400 },
    );
  }
  // Materialize the row if it doesn't exist yet, then apply the patch.
  await getOrInitConversationSettings({
    channel: parsed.data.channel,
    conversationKey: parsed.data.conversation_key,
    createdByUserId: user.id,
  });
  const settings = await updateConversationSettings({
    channel: parsed.data.channel,
    conversationKey: parsed.data.conversation_key,
    patch: parsed.data.patch,
  });
  if (!settings) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  // Auto-resume: when a budget cap was breached and the operator just
  // raised the cap above current usage, clear pausedAt/pausedReason in
  // a follow-up patch. Without this, bumping max_turns from 8 → 20
  // leaves pausedAt set and the agent stays silent until the operator
  // hits "Resume now" — which is exactly the friction Cole flagged.
  // We match on the human-formatted reason strings emitted by
  // pauseConversation() in conversation-agent.ts (`max_turns (X)
  // reached`, `max_cost_usd_cents (X) reached`, `max_duration_hours
  // (X) reached`). Stop-keyword + manual pauses don't auto-resume.
  if (settings.pausedAt && settings.pausedReason) {
    const reason = settings.pausedReason;
    const ageHours =
      (Date.now() - new Date(settings.createdAt).getTime()) / 3_600_000;
    const costUsdCents = Math.round(
      Number(settings.totalCostUsdMicros) / 10_000,
    );
    const turnsCleared =
      reason.startsWith('max_turns') &&
      settings.totalTurns < settings.maxTurns;
    const costCleared =
      reason.startsWith('max_cost_usd_cents') &&
      costUsdCents < settings.maxCostUsdCents;
    const durationCleared =
      reason.startsWith('max_duration_hours') &&
      ageHours < settings.maxDurationHours;
    if (turnsCleared || costCleared || durationCleared) {
      const resumed = await updateConversationSettings({
        channel: parsed.data.channel,
        conversationKey: parsed.data.conversation_key,
        patch: { pausedAt: null, pausedReason: null },
      });
      return NextResponse.json({ settings: resumed ?? settings });
    }
  }

  return NextResponse.json({ settings });
}
