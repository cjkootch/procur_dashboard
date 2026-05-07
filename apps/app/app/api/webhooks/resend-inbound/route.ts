import { Webhook } from 'svix';
import { and, eq, sql } from 'drizzle-orm';
import {
  contacts,
  db,
  events,
  messages,
  rawEvents,
  threads,
  touchpoints,
} from '@procur/db';
import { createId, emitOutreachOutcome } from '@procur/ai';
import { recordWebhookReceipt } from '../../../../lib/webhook-events';
import { notifyAllOperators } from '../../../../lib/notification-queries';

export const runtime = 'nodejs';

/**
 * Resend inbound-email webhook per docs/vex-into-procur-merge-brief.md
 * Phase 3. Receives Resend's "email.received" events and lands them
 * as `messages` rows on a thread, plus an `email.received` audit
 * event and an `email.received` touchpoint.
 *
 * Pipeline (mirrors vex's normalizer):
 *   1. Verify Svix signature against RESEND_INBOUND_WEBHOOK_SECRET
 *   2. Dedupe via raw_events (provider, provider_event_id) — retries
 *      collapse here, not at the messages table
 *   3. Match the inbound `from` to a contact (best-effort; null contact
 *      = triage / not-yet-known sender)
 *   4. Resolve a thread: prefer in_reply_to → parent message's thread;
 *      else create a new thread tagged by subject + sender
 *   5. Write message + event + touchpoint
 *
 * Phase 0 decisions applied: no tenant scoping. The webhook handler is
 * an unauthenticated endpoint; security comes from Svix signature
 * verification, NOT from cookie auth.
 */

interface ResendInboundEnvelope {
  type?: string;
  data?: {
    email_id?: string;
    object?: string;
    /** Resend ships from/to as either string or array; normalize. */
    from?: string | string[];
    to?: string | string[];
    subject?: string;
    text?: string;
    html?: string;
    /** RFC-5322 Message-ID. Resend may put it under headers or top-level. */
    message_id?: string;
    in_reply_to?: string;
    headers?: Record<string, string>;
    received_at?: string;
  };
}

function pickFirstEmail(value: string | string[] | undefined): string | null {
  if (!value) return null;
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) return null;
  // Resend may ship "Name <addr@host>" or just "addr@host".
  const match = raw.match(/<([^>]+)>/);
  const inner = match?.[1];
  return (inner ?? raw).trim().toLowerCase();
}

function pickAllEmails(value: string | string[] | undefined): string[] {
  if (!value) return [];
  const raws = Array.isArray(value) ? value : [value];
  const out: string[] = [];
  for (const raw of raws) {
    const match = raw.match(/<([^>]+)>/);
    const inner = match?.[1];
    const addr = (inner ?? raw).trim().toLowerCase();
    if (addr) out.push(addr);
  }
  return out;
}

export async function POST(req: Request): Promise<Response> {
  const secret = process.env.RESEND_INBOUND_WEBHOOK_SECRET;
  if (!secret) {
    return new Response('RESEND_INBOUND_WEBHOOK_SECRET not configured', {
      status: 500,
    });
  }

  const svixId = req.headers.get('svix-id');
  const svixTimestamp = req.headers.get('svix-timestamp');
  const svixSignature = req.headers.get('svix-signature');

  if (!svixId || !svixTimestamp || !svixSignature) {
    await recordWebhookReceipt({
      provider: 'resend_inbound',
      eventId: svixId,
      responseStatus: 400,
      signatureValid: false,
      errorMessage: 'missing svix headers',
    });
    return new Response('missing svix headers', { status: 400 });
  }

  const body = await req.text();
  const wh = new Webhook(secret);
  let envelope: ResendInboundEnvelope;
  try {
    envelope = wh.verify(body, {
      'svix-id': svixId,
      'svix-timestamp': svixTimestamp,
      'svix-signature': svixSignature,
    }) as ResendInboundEnvelope;
  } catch (err) {
    await recordWebhookReceipt({
      provider: 'resend_inbound',
      eventId: svixId,
      responseStatus: 401,
      signatureValid: false,
      errorMessage:
        err instanceof Error ? err.message : 'invalid signature',
    });
    return new Response('invalid signature', { status: 401 });
  }

  const data = envelope.data ?? {};
  const fromEmail = pickFirstEmail(data.from);
  const toEmails = pickAllEmails(data.to);
  const messageId = data.message_id ?? data.headers?.['Message-ID'] ?? null;
  const inReplyTo =
    data.in_reply_to ?? data.headers?.['In-Reply-To'] ?? null;
  const subject = data.subject ?? null;
  const bodyText = data.text ?? null;
  const bodyHtml = data.html ?? null;
  const occurredAt = data.received_at ? new Date(data.received_at) : new Date();

  const providerEventId = messageId ?? data.email_id ?? svixId;

  // The Resend webhook can be subscribed to inbound (`email.received`)
  // OR outbound delivery events (`email.sent`, `email.delivered`,
  // `email.bounced`, `email.complained`, `email.opened`, `email.clicked`,
  // `email.delivery_delayed`). Phase 3 only handles the inbound
  // event end-to-end; outbound events still get an audit row in
  // raw_events so we can wire a delivery-status handler later
  // (Phase 6 cleanup or a follow-up PR), but they DON'T flow into
  // messages / threads / touchpoints — those tables assume an inbound
  // shape with from/body/in_reply_to.
  const isInbound = envelope.type === 'email.received';

  // Always record the raw payload for audit, regardless of type.
  await db
    .insert(rawEvents)
    .values({
      id: createId(),
      provider: 'resend',
      providerEventId,
      headers: (data.headers ?? {}) as Record<string, unknown>,
      payload: envelope as unknown as Record<string, unknown>,
      receivedAt: occurredAt,
      status: isInbound ? 'pending' : 'processed',
    })
    .onConflictDoNothing({
      target: [
        rawEvents.receivedAt,
        rawEvents.provider,
        rawEvents.providerEventId,
      ],
    });

  if (!isInbound) {
    await recordWebhookReceipt({
      provider: 'resend_inbound',
      eventId: svixId,
      eventType: envelope.type ?? null,
      responseStatus: 200,
      signatureValid: true,
      processed: true,
      payload: envelope,
    });
    return new Response('ok (non-inbound event recorded for audit)', {
      status: 200,
    });
  }

  // Step 2: dedupe via messages.message_id (unique partial index in
  // migration 0080). If the message_id already exists, return early.
  if (messageId) {
    const existing = await db
      .select({ id: messages.id })
      .from(messages)
      .where(eq(messages.messageId, messageId))
      .limit(1);
    if (existing.length > 0) {
      await recordWebhookReceipt({
        provider: 'resend_inbound',
        eventId: svixId,
        eventType: envelope.type ?? null,
        responseStatus: 200,
        signatureValid: true,
        processed: true,
        payload: envelope,
      });
      return new Response('duplicate', { status: 200 });
    }
  }

  // Step 3: best-effort contact match.
  let contactId: string | null = null;
  let contactOrgId: string | null = null;
  if (fromEmail) {
    const contactRow = await db
      .select({ id: contacts.id, orgId: contacts.orgId })
      .from(contacts)
      .where(sql`${contacts.emails} @> ${JSON.stringify([fromEmail])}::jsonb`)
      .limit(1);
    if (contactRow[0]) {
      contactId = contactRow[0].id;
      contactOrgId = contactRow[0].orgId;
    }
  }

  // Step 4: resolve thread. Prefer parent's thread; else create new.
  let threadId: string | null = null;
  if (inReplyTo) {
    const parent = await db
      .select({ threadId: messages.threadId })
      .from(messages)
      .where(eq(messages.messageId, inReplyTo))
      .limit(1);
    if (parent[0]) threadId = parent[0].threadId;
  }
  if (!threadId) {
    threadId = createId();
    await db.insert(threads).values({
      id: threadId,
      channel: 'email',
      subject: subject ?? null,
      participantIds: contactId ? [contactId] : [],
      lastMessageAt: occurredAt,
    });
  } else {
    await db
      .update(threads)
      .set({ lastMessageAt: occurredAt })
      .where(eq(threads.id, threadId));
  }

  // Step 5: insert message + event + touchpoint.
  const newMessageId = createId();
  await db.insert(messages).values({
    id: newMessageId,
    threadId,
    direction: 'inbound',
    subject: subject ?? null,
    fromEmail: fromEmail ?? null,
    messageId: messageId ?? null,
    inReplyTo: inReplyTo ?? null,
    metadata: {
      to: toEmails,
      body_text: bodyText?.slice(0, 64_000) ?? null,
      body_html: bodyHtml?.slice(0, 64_000) ?? null,
      contact_id: contactId,
      org_id: contactOrgId,
      provider_email_id: data.email_id ?? null,
    },
  });

  await db
    .insert(events)
    .values({
      id: createId(),
      verb: 'email.received',
      subjectType: 'message',
      subjectId: newMessageId,
      actorType: contactId ? 'contact' : 'unknown',
      actorId: contactId ?? fromEmail,
      objectType: 'thread',
      objectId: threadId,
      occurredAt,
      idempotencyKey: `email.received:${providerEventId}`,
      metadata: {
        from_email: fromEmail,
        subject,
        message_id: messageId,
        contact_matched: Boolean(contactId),
      },
    })
    .onConflictDoNothing({
      target: [events.occurredAt, events.idempotencyKey],
    });

  await db.insert(touchpoints).values({
    id: createId(),
    channel: 'email.received',
    actor: fromEmail ?? 'unknown',
    occurredAt,
    contactId,
    orgId: contactOrgId,
    metadata: {
      message_id: messageId,
      thread_id: threadId,
      subject,
      preview: bodyText?.slice(0, 240) ?? null,
    },
  });

  // Outreach lifecycle: when an inbound message lands in a thread that
  // has any outbound message we previously sent via the recommendation
  // pipeline, emit `outreach.replied` against the originating approval.
  // This is the join Match Performance Dashboard pivots on (model
  // version + evidence item ids → reply outcome).
  //
  // Look only at outbound messages with an `approval_id` in metadata —
  // those are the ones our executors stamped (email-send.ts:319).
  // Manual operator-driven sends without an approvalId can't be
  // attributed and silently no-op here.
  await emitRepliedForThread({ threadId, occurredAt, messageDbId: newMessageId });

  // Operator notification — bell + (client-side) toast. Single-user
  // deployment fans out to every user; multi-tenant should narrow by
  // inferred company. Failure is silent so a notification write
  // never breaks the inbound webhook (notifyAllOperators swallows
  // its own errors per its contract).
  await notifyAllOperators({
    type: 'comm.email_received',
    title: `New email from ${fromEmail ?? 'unknown sender'}`,
    body: subject ?? bodyText?.slice(0, 200) ?? null,
    link: `/inbox/${threadId}`,
    entityType: 'thread',
    entityId: null,
  });

  await db
    .update(rawEvents)
    .set({ status: 'processed' })
    .where(
      sql`${rawEvents.providerEventId} = ${providerEventId} AND ${rawEvents.provider} = 'resend'`,
    );

  await recordWebhookReceipt({
    provider: 'resend_inbound',
    eventId: svixId,
    eventType: envelope.type ?? null,
    responseStatus: 200,
    signatureValid: true,
    processed: true,
    payload: envelope,
  });

  return new Response('ok', { status: 200 });
}

/**
 * Find the originating approval id for any outbound message in the
 * thread (executors stamp `approval_id` into messages.metadata) and
 * emit `outreach.replied` against it. Idempotent — emitOutreachOutcome
 * dedupes on (approvalId, verb).
 *
 * Skips when the thread has only inbound messages (cold inbound) or
 * outbound from a manual operator send (no approvalId in metadata).
 */
async function emitRepliedForThread(args: {
  threadId: string;
  occurredAt: Date;
  messageDbId: string;
}): Promise<void> {
  const outboundRows = await db
    .select({ metadata: messages.metadata })
    .from(messages)
    .where(
      and(eq(messages.threadId, args.threadId), eq(messages.direction, 'outbound')),
    );

  const seen = new Set<string>();
  for (const row of outboundRows) {
    const meta = (row.metadata ?? {}) as Record<string, unknown>;
    const approvalId = meta['approval_id'];
    if (typeof approvalId !== 'string' || seen.has(approvalId)) continue;
    seen.add(approvalId);
    await emitOutreachOutcome({
      approvalId,
      verb: 'outreach.replied',
      occurredAt: args.occurredAt,
      objectId: args.messageDbId,
      objectType: 'message',
      metadata: {
        thread_id: args.threadId,
        inbound_message_id: args.messageDbId,
      },
    });
  }
}
