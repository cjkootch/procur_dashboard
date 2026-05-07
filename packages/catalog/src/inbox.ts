import 'server-only';
import { and, desc, eq, gte, isNotNull, sql } from 'drizzle-orm';
import { contacts, db, messages, threads, touchpoints } from '@procur/db';

/**
 * Inbox helpers for vex-into-procur merge Phase 3. The inbox UI groups
 * messages by thread; vex's UI uses a flat timeline (touchpoints +
 * activities merged). Procur ships the thread-grouped variant because
 * Phase 1 schema has explicit thread rows.
 */

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
  const rows = await db
    .select({
      id: threads.id,
      channel: threads.channel,
      subject: threads.subject,
      participantIds: threads.participantIds,
      lastMessageAt: threads.lastMessageAt,
      createdAt: threads.createdAt,
      messageCount: sql<number>`(SELECT count(*)::int FROM ${messages} WHERE ${messages.threadId} = ${threads.id})`,
      lastFromEmail: sql<string | null>`(
        SELECT ${messages.fromEmail}
        FROM ${messages}
        WHERE ${messages.threadId} = ${threads.id}
        ORDER BY ${messages.createdAt} DESC
        LIMIT 1
      )`,
    })
    .from(threads)
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
