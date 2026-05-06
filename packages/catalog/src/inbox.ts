import 'server-only';
import { desc, eq, sql } from 'drizzle-orm';
import { db, messages, threads } from '@procur/db';

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
