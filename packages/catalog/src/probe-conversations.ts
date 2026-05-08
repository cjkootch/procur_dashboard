import 'server-only';
import { and, desc, eq, sql } from 'drizzle-orm';
import {
  conversationSettings,
  db,
  knownEntities,
  type ConversationSettings,
} from '@procur/db';

/**
 * Per-probe conversations view. Reads `conversation_settings`
 * filtered by `linked_probe_id` and joins the entity name (best-
 * effort) so the operator can see WHO they've been talking to.
 *
 * One row per (channel, conversationKey) — that's the existing
 * unique key on conversation_settings. For email channels the key
 * is the recipient email address; for lead_form it's the form URL;
 * for sms/voice/whatsapp it's the recipient's E.164 number.
 *
 * `lastActivityAt` is conversation_settings.updatedAt for now —
 * not perfectly accurate (settings updates touch this too) but
 * close enough for MVP. v2 should query touchpoints + messages and
 * surface actual inbound/outbound counts.
 */
export interface ProbeConversationRow {
  channel: string;
  conversationKey: string;
  linkedEntitySlug: string | null;
  entityName: string | null;
  approvalMode: ConversationSettings['approvalMode'];
  authority: ConversationSettings['authority'];
  language: string;
  lastActivityAt: Date;
}

export async function listProbeConversations(
  probeId: string,
): Promise<ProbeConversationRow[]> {
  const rows = await db
    .select({
      channel: conversationSettings.channel,
      conversationKey: conversationSettings.conversationKey,
      linkedEntitySlug: conversationSettings.linkedEntitySlug,
      approvalMode: conversationSettings.approvalMode,
      authority: conversationSettings.authority,
      language: conversationSettings.language,
      updatedAt: conversationSettings.updatedAt,
      entityName: knownEntities.name,
    })
    .from(conversationSettings)
    .leftJoin(
      knownEntities,
      sql`${conversationSettings.linkedEntitySlug} = ${knownEntities.slug}`,
    )
    .where(
      and(
        eq(conversationSettings.linkedProbeId, probeId),
        eq(conversationSettings.aiEnabled, true),
      ),
    )
    .orderBy(desc(conversationSettings.updatedAt))
    .limit(200);
  return rows.map((r) => ({
    channel: r.channel,
    conversationKey: r.conversationKey,
    linkedEntitySlug: r.linkedEntitySlug ?? null,
    entityName: r.entityName ?? null,
    approvalMode: r.approvalMode,
    authority: r.authority,
    language: r.language,
    lastActivityAt: r.updatedAt,
  }));
}
