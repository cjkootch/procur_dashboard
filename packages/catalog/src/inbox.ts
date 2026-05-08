import 'server-only';
import { and, desc, eq, gte, isNotNull, sql } from 'drizzle-orm';
import { contacts, db, messages, threads, touchpoints } from '@procur/db';

/**
 * Inbox helpers for vex-into-procur merge Phase 3. The inbox UI groups
 * messages by thread; vex's UI uses a flat timeline (touchpoints +
 * activities merged). Procur ships the thread-grouped variant because
 * Phase 1 schema has explicit thread rows.
 */

/**
 * Normalize an RFC 5322 Message-ID for storage / lookup. Strips the
 * surrounding angle brackets, trims whitespace, and lowercases —
 * Message-IDs are case-insensitive per RFC, and different relays
 * preserve the brackets inconsistently in `In-Reply-To` headers, so
 * exact-match lookups fail intermittently without normalization.
 *
 * Use BOTH when storing on the outbound side AND when looking up the
 * inbound `In-Reply-To` to resolve a parent thread. Returns null on
 * empty input so callers can chain through optional values.
 */
export function normalizeRfcMessageId(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  // Some clients pack multiple Message-IDs into a single In-Reply-To
  // header (rare but legal). Take the first — that's the immediate
  // parent; chained ancestors live in References instead.
  const first = trimmed.split(/\s+/)[0]!;
  return first.replace(/^<+/, '').replace(/>+$/, '').toLowerCase();
}

/**
 * Resolve the thread a parent Message-ID belongs to, tolerating
 * angle-bracket / case / whitespace variations. Returns null when no
 * matching outbound exists (the inbound is a fresh conversation).
 */
export async function findThreadIdByInReplyTo(
  inReplyTo: string | null | undefined,
): Promise<string | null> {
  const normalized = normalizeRfcMessageId(inReplyTo);
  if (!normalized) return null;
  // Match against either the canonical normalized form OR the legacy
  // bracketed form for rows that pre-date the backfill. Drop the
  // legacy clause once we're confident every row has been normalized.
  const legacy = `<${normalized}>`;
  const rows = await db
    .select({ threadId: messages.threadId })
    .from(messages)
    .where(
      sql`${messages.messageId} = ${normalized} OR ${messages.messageId} = ${legacy}`,
    )
    .limit(1);
  return rows[0]?.threadId ?? null;
}

export interface ThreadListRow {
  id: string;
  channel: string;
  subject: string | null;
  participantIds: string[];
  lastMessageAt: Date | null;
  createdAt: Date;
  /** Most recent message's from_email — useful for the list preview. */
  lastFromEmail: string | null;
  /** Char count of the most recent message body — for the preview line. */
  messageCount: number;
}

export async function listInboxThreads(
  options: { limit?: number } = {},
): Promise<ThreadListRow[]> {
  const limit = options.limit ?? 50;
  // Subqueries written with literal table names rather than
  // ${messages}/${threads} interpolation. Drizzle's tagged-template
  // alias generation in nested subqueries shadowed the outer
  // `threads` reference — messageCount came back as 0 even when the
  // thread had messages, and lastFromEmail was always null. Hard-
  // coding the table names is uglier but correct.
  const rows = await db
    .select({
      id: threads.id,
      channel: threads.channel,
      subject: threads.subject,
      participantIds: threads.participantIds,
      lastMessageAt: threads.lastMessageAt,
      createdAt: threads.createdAt,
      messageCount: sql<number>`(
        SELECT count(*)::int
        FROM messages m
        WHERE m.thread_id = threads.id
      )`,
      lastFromEmail: sql<string | null>`(
        SELECT COALESCE(m.from_email, m.metadata->>'from')
        FROM messages m
        WHERE m.thread_id = threads.id
        ORDER BY m.created_at DESC
        LIMIT 1
      )`,
    })
    .from(threads)
    // Hide orphan threads (created but the message insert failed
    // mid-write — e.g. Resend retry between secret rotation). Without
    // this filter the inbox shows ghost rows with 0 messages and no
    // sender, which is just noise.
    .where(sql`EXISTS (SELECT 1 FROM messages m WHERE m.thread_id = threads.id)`)
    .orderBy(desc(threads.lastMessageAt))
    .limit(limit);

  return rows.map((r) => ({
    id: r.id,
    channel: r.channel,
    subject: r.subject ?? null,
    participantIds: (r.participantIds as string[] | null) ?? [],
    lastMessageAt: r.lastMessageAt,
    createdAt: r.createdAt,
    lastFromEmail: r.lastFromEmail,
    messageCount: Number(r.messageCount ?? 0),
  }));
}

export interface ThreadMessageRow {
  id: string;
  threadId: string;
  direction: 'inbound' | 'outbound';
  subject: string | null;
  fromEmail: string | null;
  messageId: string | null;
  inReplyTo: string | null;
  bodyText: string | null;
  bodyHtml: string | null;
  /** English translation of bodyText, or null when source was already
   *  English (or translation hasn't run). Populated by the resend-
   *  inbound webhook via translateInboundMessage. */
  bodyTextEn: string | null;
  /** English translation of subject when applicable. */
  subjectEn: string | null;
  /** ISO 639-1 (or 639-3 fallback) of the detected source language.
   *  null when detection didn't run / failed. */
  detectedLanguageCode: string | null;
  /** Human-readable language name for the "Translated from …" chip. */
  detectedLanguageName: string | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
}

export interface ThreadDetail {
  thread: {
    id: string;
    channel: string;
    subject: string | null;
    participantIds: string[];
    lastMessageAt: Date | null;
    createdAt: Date;
  };
  messages: ThreadMessageRow[];
}

export async function getThreadDetail(
  threadId: string,
): Promise<ThreadDetail | null> {
  const threadRows = await db
    .select({
      id: threads.id,
      channel: threads.channel,
      subject: threads.subject,
      participantIds: threads.participantIds,
      lastMessageAt: threads.lastMessageAt,
      createdAt: threads.createdAt,
    })
    .from(threads)
    .where(eq(threads.id, threadId))
    .limit(1);
  const thread = threadRows[0];
  if (!thread) return null;

  const messageRows = await db
    .select({
      id: messages.id,
      threadId: messages.threadId,
      direction: messages.direction,
      subject: messages.subject,
      fromEmail: messages.fromEmail,
      messageId: messages.messageId,
      inReplyTo: messages.inReplyTo,
      metadata: messages.metadata,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .where(eq(messages.threadId, threadId))
    .orderBy(messages.createdAt);

  return {
    thread: {
      id: thread.id,
      channel: thread.channel,
      subject: thread.subject ?? null,
      participantIds: (thread.participantIds as string[] | null) ?? [],
      lastMessageAt: thread.lastMessageAt,
      createdAt: thread.createdAt,
    },
    messages: messageRows.map((m) => {
      const meta = (m.metadata ?? {}) as Record<string, unknown>;
      const bodyText =
        typeof meta['body_text'] === 'string'
          ? (meta['body_text'] as string)
          : null;
      const bodyHtml =
        typeof meta['body_html'] === 'string'
          ? (meta['body_html'] as string)
          : null;
      const bodyTextEn =
        typeof meta['body_text_en'] === 'string'
          ? (meta['body_text_en'] as string)
          : null;
      const subjectEn =
        typeof meta['subject_en'] === 'string'
          ? (meta['subject_en'] as string)
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
        id: m.id,
        threadId: m.threadId,
        direction: m.direction,
        subject: m.subject ?? null,
        fromEmail: m.fromEmail ?? null,
        messageId: m.messageId ?? null,
        inReplyTo: m.inReplyTo ?? null,
        bodyText,
        bodyHtml,
        bodyTextEn,
        subjectEn,
        detectedLanguageCode,
        detectedLanguageName,
        metadata: meta,
        createdAt: m.createdAt,
      };
    }),
  };
}

/**
 * Look up the RFC Message-ID the assistant should pass as `inReplyTo`
 * to thread a reply correctly. Returns the latest message in the
 * thread that has a `messageId` populated — typical email-client
 * behavior is "reply to the most recent message regardless of
 * direction." Falls back to null when the thread has no messages
 * with a known Message-ID (e.g. legacy inbound rows).
 */
export interface ReplyTarget {
  threadId: string;
  subject: string | null;
  latestMessageId: string;
  latestMessageDirection: 'inbound' | 'outbound';
  latestMessageAt: Date;
  latestFromEmail: string | null;
}

export async function lookupReplyTarget(
  threadId: string,
): Promise<ReplyTarget | null> {
  const rows = await db
    .select({
      threadId: messages.threadId,
      subject: messages.subject,
      messageId: messages.messageId,
      direction: messages.direction,
      createdAt: messages.createdAt,
      fromEmail: messages.fromEmail,
      threadSubject: threads.subject,
    })
    .from(messages)
    .innerJoin(threads, eq(threads.id, messages.threadId))
    .where(
      and(eq(messages.threadId, threadId), isNotNull(messages.messageId)),
    )
    .orderBy(desc(messages.createdAt))
    .limit(1);
  const row = rows[0];
  if (!row || !row.messageId) return null;
  return {
    threadId: row.threadId,
    subject: row.subject ?? row.threadSubject ?? null,
    latestMessageId: row.messageId,
    latestMessageDirection: row.direction,
    latestMessageAt: row.createdAt,
    latestFromEmail: row.fromEmail ?? null,
  };
}

export interface RecentTouchpointRow {
  id: string;
  channel: string;
  occurredAt: Date;
  contactId: string | null;
  orgId: string | null;
  metadata: Record<string, unknown>;
}

export interface RecentTouchpointsResult {
  contact: {
    id: string;
    fullName: string | null;
    optedOutAt: Date | null;
    optOutReason: string | null;
  } | null;
  touchpoints: RecentTouchpointRow[];
  /** Convenience flag — true if the contact is opted out, regardless of
   *  channel. Chat callers should refuse to propose new outreach. */
  optedOut: boolean;
}

/**
 * Return the contact's recent touchpoints (across all channels) plus
 * their opt-out status. Used by the chat assistant before proposing
 * outreach so it doesn't re-spam someone contacted yesterday or who
 * has explicitly opted out.
 *
 * `sinceHours` defaults to 168 (one week). `limit` defaults to 25.
 */
export async function listRecentTouchpoints(input: {
  contactId: string;
  sinceHours?: number;
  limit?: number;
}): Promise<RecentTouchpointsResult> {
  const sinceHours = input.sinceHours ?? 168;
  const limit = input.limit ?? 25;
  const since = new Date(Date.now() - sinceHours * 3600_000);

  const contactRows = await db
    .select({
      id: contacts.id,
      fullName: contacts.fullName,
      optOutAt: contacts.optOutAt,
      optOutReason: contacts.optOutReason,
    })
    .from(contacts)
    .where(eq(contacts.id, input.contactId))
    .limit(1);
  const contact = contactRows[0] ?? null;

  const tpRows = await db
    .select({
      id: touchpoints.id,
      channel: touchpoints.channel,
      occurredAt: touchpoints.occurredAt,
      contactId: touchpoints.contactId,
      orgId: touchpoints.orgId,
      metadata: touchpoints.metadata,
    })
    .from(touchpoints)
    .where(
      and(
        eq(touchpoints.contactId, input.contactId),
        gte(touchpoints.occurredAt, since),
      ),
    )
    .orderBy(desc(touchpoints.occurredAt))
    .limit(limit);

  return {
    contact: contact
      ? {
          id: contact.id,
          fullName: contact.fullName ?? null,
          optedOutAt: contact.optOutAt ?? null,
          optOutReason: contact.optOutReason ?? null,
        }
      : null,
    touchpoints: tpRows.map((r) => ({
      id: r.id,
      channel: r.channel,
      occurredAt: r.occurredAt,
      contactId: r.contactId ?? null,
      orgId: r.orgId ?? null,
      metadata: (r.metadata as Record<string, unknown>) ?? {},
    })),
    optedOut: contact?.optOutAt != null,
  };
}
