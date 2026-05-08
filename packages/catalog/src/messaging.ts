import 'server-only';
import { and, desc, eq, like, or, sql } from 'drizzle-orm';
import { contacts, db, touchpoints } from '@procur/db';

/**
 * Messaging conversations — SMS + WhatsApp threads grouped by
 * counterparty phone (E.164). Powers `/messages` (list) and
 * `/messages/[phone]` (phone-text-bubble view). Email lives in
 * /inbox via the threads + messages tables; messaging stays on
 * touchpoints because there's no per-message thread row for SMS/
 * WhatsApp — the natural conversation key is the phone number.
 *
 * Touchpoint shape we read:
 *   - outbound channels: 'sms.sent', 'whatsapp.sent'
 *     metadata.to = E.164 phone
 *   - inbound channels: 'sms.received', 'whatsapp.received'
 *     metadata.from = E.164 phone
 *
 * The phone is the conversation key in both cases.
 */

export interface MessagingConversation {
  /** E.164 — leading +, country code, then digits. */
  phone: string;
  /** sms / whatsapp — the channel of the most recent message. */
  channel: 'sms' | 'whatsapp' | 'mixed';
  contactId: string | null;
  contactName: string | null;
  lastMessageAt: Date;
  lastMessagePreview: string | null;
  lastDirection: 'inbound' | 'outbound';
  totalMessages: number;
}

export interface MessagingMessage {
  id: string;
  channel: 'sms' | 'whatsapp';
  direction: 'inbound' | 'outbound';
  occurredAt: Date;
  body: string | null;
  /** English translation of body, or null when source was already
   *  English (or translation hasn't run). Populated by the twilio
   *  inbound webhook via translateInboundMessage. */
  bodyEn: string | null;
  detectedLanguageCode: string | null;
  detectedLanguageName: string | null;
  /** Twilio MessageSid when known. */
  providerMessageId: string | null;
  /** Approval id when this message came from a recommendation-pipeline
   *  send (touchpoints.actor LIKE 'approval:%'). */
  sourceApprovalId: string | null;
}

export interface MessagingConversationDetail {
  phone: string;
  contactId: string | null;
  contactName: string | null;
  /** All messages oldest → newest. The bubble view renders top-to-
   *  bottom; the freshest sits at the bottom (phone-text convention). */
  messages: MessagingMessage[];
}

/**
 * List recent SMS + WhatsApp conversations, grouped by counterparty
 * phone, sorted by most recent activity.
 *
 * Implementation: scan touchpoints with channel like 'sms.%' or
 * 'whatsapp.%' over the last `lookbackDays` (default 90), pull the
 * counterparty phone out of metadata.to (outbound) or metadata.from
 * (inbound), group, hydrate contact info.
 */
export async function listMessagingConversations(
  options: { limit?: number; lookbackDays?: number } = {},
): Promise<MessagingConversation[]> {
  const limit = options.limit ?? 50;
  const lookback = options.lookbackDays ?? 90;
  const since = new Date(Date.now() - lookback * 24 * 60 * 60 * 1000);

  // Pull the universe of messaging touchpoints in the window. Bounded
  // result set: 50 conversations × dozens of messages = thousands of
  // rows max; well under what Neon HTTP wants. Group server-side via
  // a CTE so the conversation count + last-message preview both come
  // from one round-trip.
  const rows = await db.execute<{
    phone: string;
    last_channel: string;
    last_at: Date;
    last_direction: string;
    last_preview: string | null;
    total_messages: number;
    channels: string[];
  }>(sql`
    WITH msgs AS (
      SELECT
        CASE
          WHEN channel LIKE '%.sent' THEN metadata->>'to'
          ELSE metadata->>'from'
        END AS phone,
        channel,
        occurred_at,
        CASE
          WHEN channel LIKE '%.sent' THEN 'outbound'
          ELSE 'inbound'
        END AS direction,
        metadata->>'body_preview' AS preview,
        contact_id,
        actor
      FROM touchpoints
      WHERE (channel LIKE 'sms.%' OR channel LIKE 'whatsapp.%')
        AND occurred_at >= ${since}
    ),
    grouped AS (
      SELECT
        phone,
        MAX(occurred_at) AS last_at,
        COUNT(*)::int AS total_messages,
        ARRAY_AGG(DISTINCT channel) AS channels
      FROM msgs
      WHERE phone IS NOT NULL AND phone <> ''
      GROUP BY phone
    ),
    last_msg AS (
      SELECT DISTINCT ON (phone)
        phone, channel AS last_channel, direction AS last_direction,
        preview AS last_preview
      FROM msgs
      WHERE phone IS NOT NULL AND phone <> ''
      ORDER BY phone, occurred_at DESC
    )
    SELECT g.phone, l.last_channel, g.last_at, l.last_direction,
           l.last_preview, g.total_messages, g.channels
      FROM grouped g
      JOIN last_msg l ON l.phone = g.phone
     ORDER BY g.last_at DESC
     LIMIT ${limit}
  `);

  if (rows.rows.length === 0) return [];

  // Hydrate contact names by phone. Contacts.phones is JSONB — use
  // OR-of-`@>` to leverage the GIN index. Earlier `?|` form blew up
  // on Neon HTTP because the `?` is also Postgres's parameter marker
  // outside numbered-parameter mode and the driver couldn't keep
  // them straight.
  const phones = rows.rows.map((r) => r.phone);
  const contactRows = await db
    .select({
      id: contacts.id,
      fullName: contacts.fullName,
      phones: contacts.phones,
    })
    .from(contacts)
    .where(
      or(
        ...phones.map(
          (p) => sql`${contacts.phones} @> ${JSON.stringify([p])}::jsonb`,
        ),
      ),
    );

  const contactByPhone = new Map<
    string,
    { id: string; fullName: string | null }
  >();
  for (const c of contactRows) {
    const phoneArray = (c.phones as string[] | null) ?? [];
    for (const p of phoneArray) {
      if (phones.includes(p) && !contactByPhone.has(p)) {
        contactByPhone.set(p, { id: c.id, fullName: c.fullName });
      }
    }
  }

  return rows.rows.map((r) => {
    const channel = inferChannelGroup(r.channels ?? [r.last_channel]);
    const contact = contactByPhone.get(r.phone) ?? null;
    return {
      phone: r.phone,
      channel,
      contactId: contact?.id ?? null,
      contactName: contact?.fullName ?? null,
      // Neon HTTP returns timestamps as ISO strings, not Date — the
      // typed `db.execute<{last_at: Date}>` is a TypeScript-only
      // assertion. The page's render path calls `.toISOString()` on
      // this value, which throws on a string. Coerce defensively.
      lastMessageAt: r.last_at instanceof Date ? r.last_at : new Date(r.last_at as unknown as string),
      lastMessagePreview: r.last_preview ?? null,
      lastDirection: (r.last_direction as 'inbound' | 'outbound') ?? 'inbound',
      totalMessages: Number(r.total_messages ?? 0),
    };
  });
}

/**
 * Single conversation (full message history with the given E.164
 * phone). Returns null when there are no messaging touchpoints for
 * the phone — let the page 404.
 */
export async function getMessagingConversation(
  phone: string,
  options: { limit?: number } = {},
): Promise<MessagingConversationDetail | null> {
  const limit = options.limit ?? 500;

  const rows = await db
    .select({
      id: touchpoints.id,
      channel: touchpoints.channel,
      occurredAt: touchpoints.occurredAt,
      contactId: touchpoints.contactId,
      actor: touchpoints.actor,
      metadata: touchpoints.metadata,
    })
    .from(touchpoints)
    .where(
      and(
        // sms.* or whatsapp.* prefix match
        sql`(${touchpoints.channel} LIKE 'sms.%' OR ${touchpoints.channel} LIKE 'whatsapp.%')`,
        // metadata.to (outbound) OR metadata.from (inbound) matches
        sql`(${touchpoints.metadata}->>'to' = ${phone} OR ${touchpoints.metadata}->>'from' = ${phone})`,
      ),
    )
    .orderBy(touchpoints.occurredAt)
    .limit(limit);

  if (rows.length === 0) return null;

  // Pick the contact off the first row that has one. Phone-keyed
  // conversation usually has a stable contactId across messages.
  let contactId: string | null = null;
  let contactName: string | null = null;
  for (const r of rows) {
    if (r.contactId) {
      contactId = r.contactId;
      break;
    }
  }
  if (contactId) {
    const c = await db
      .select({ fullName: contacts.fullName })
      .from(contacts)
      .where(eq(contacts.id, contactId))
      .limit(1);
    contactName = c[0]?.fullName ?? null;
  }

  const messages: MessagingMessage[] = rows.map((r) => {
    const meta = (r.metadata ?? {}) as Record<string, unknown>;
    const channelGroup: 'sms' | 'whatsapp' = r.channel.startsWith('whatsapp')
      ? 'whatsapp'
      : 'sms';
    const direction: 'inbound' | 'outbound' = r.channel.endsWith('.sent')
      ? 'outbound'
      : 'inbound';
    const body =
      typeof meta['body_preview'] === 'string'
        ? (meta['body_preview'] as string)
        : typeof meta['body_text'] === 'string'
          ? (meta['body_text'] as string)
          : null;
    const providerMessageId =
      typeof meta['provider_message_id'] === 'string'
        ? (meta['provider_message_id'] as string)
        : null;
    const sourceApprovalId =
      typeof r.actor === 'string' && r.actor.startsWith('approval:')
        ? r.actor.slice('approval:'.length)
        : null;
    const bodyEn =
      typeof meta['body_text_en'] === 'string'
        ? (meta['body_text_en'] as string)
        : null;
    const detectedLanguageCode =
      typeof meta['detected_language_code'] === 'string'
        ? (meta['detected_language_code'] as string)
        : null;
    const detectedLanguageName =
      typeof meta['detected_language_name'] === 'string'
        ? (meta['detected_language_name'] as string)
        : null;
    return {
      id: r.id,
      channel: channelGroup,
      direction,
      occurredAt: r.occurredAt,
      body,
      bodyEn,
      detectedLanguageCode,
      detectedLanguageName,
      providerMessageId,
      sourceApprovalId,
    };
  });

  return { phone, contactId, contactName, messages };
}

/** Roll up "sms.sent / sms.received / whatsapp.sent" → 'sms' | 'whatsapp' | 'mixed'. */
function inferChannelGroup(channels: string[]): 'sms' | 'whatsapp' | 'mixed' {
  let sms = false;
  let wa = false;
  for (const c of channels) {
    if (c.startsWith('sms')) sms = true;
    if (c.startsWith('whatsapp')) wa = true;
  }
  if (sms && wa) return 'mixed';
  if (wa) return 'whatsapp';
  return 'sms';
}

// Silence unused-import lint when the partial-match helper isn't called
// inside the conversation detail path. Drizzle's `like()` is exported so
// callers can extend the channel match if needed.
void like;
