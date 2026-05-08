import { Webhook } from 'svix';
import { and, eq, sql } from 'drizzle-orm';
import {
  contacts,
  conversationSettings,
  db,
  events,
  marketProbes,
  messages,
  rawEvents,
  threads,
  touchpoints,
} from '@procur/db';
import {
  createId,
  emitOutreachOutcome,
  translateInboundMessage,
} from '@procur/ai';
import {
  findThreadIdByInReplyTo,
  maybeQueueAiEmailReply,
  normalizeRfcMessageId,
  parseSubAddressToken,
  probeDomainHintGuidance,
  probeFormalityGuidance,
  resolveLeadFormSubmissionToken,
} from '@procur/catalog';
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
    headers?: ResendHeadersField;
    references?: string;
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

/**
 * Case-insensitive header lookup tolerant of BOTH shapes Resend ships:
 *
 *   Array form (what email.delivered / email.sent give us, and what
 *   GET /emails/receiving/{id} returns for inbound):
 *     [{ name: 'In-Reply-To', value: '<id@host>' }, ...]
 *
 *   Object form (what some legacy webhook payloads use):
 *     { 'In-Reply-To': '<id@host>', ... }
 *
 * RFC 5322 says header names are case-insensitive; both shapes are
 * compared with toLowerCase(). Returns null when not found OR when the
 * input itself is null/undefined.
 */
function pickHeader(
  headers: ResendHeadersField,
  name: string,
): string | null {
  if (headers == null) return null;
  const lower = name.toLowerCase();
  if (Array.isArray(headers)) {
    for (const h of headers) {
      if (h && typeof h === 'object' && typeof h.name === 'string') {
        if (h.name.toLowerCase() === lower) {
          return typeof h.value === 'string' && h.value.length > 0
            ? h.value
            : null;
        }
      }
    }
    return null;
  }
  if (typeof headers === 'object') {
    for (const [k, v] of Object.entries(headers)) {
      if (k.toLowerCase() === lower && typeof v === 'string' && v.length > 0) {
        return v;
      }
    }
  }
  return null;
}

type ResendHeaderEntry = { name?: string; value?: string };
type ResendHeadersField =
  | ResendHeaderEntry[]
  | Record<string, string>
  | null
  | undefined;

/**
 * Extract the immediate-parent Message-ID from a `References`
 * header value. References is space-separated `<id1@host> <id2@host> …`
 * with the most recent ancestor LAST per RFC 5322. We use this as a
 * fallback when `In-Reply-To` is missing — modern clients (Outlook,
 * Gmail, Apple Mail) all emit both headers, so References gives us
 * a robust second chance at threading.
 */
function lastReferenceId(value: string | null): string | null {
  if (!value) return null;
  const tokens = value.match(/<[^>]+>/g);
  if (!tokens || tokens.length === 0) return null;
  return tokens[tokens.length - 1] ?? null;
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
  const subject = data.subject ?? null;

  // Lead-form reply attribution. When the autopilot submits a
  // counterparty's contact form, the form's email field gets the
  // sub-addressed sender (hello+<token>@DOMAIN). Recipients replying
  // to the form acknowledgement send to that exact address. Scan
  // To: addresses for any plus-addressed variant; resolve the token
  // to (probe, target, entity_slug) so we can attach probe context
  // to this inbound. Without this, the operator would see an
  // unattributed inbound and the AI auto-reply path wouldn't know
  // which probe persona to use.
  let leadFormAttribution: {
    token: string;
    probeId: string;
    targetId: string;
    entitySlug: string;
  } | null = null;
  for (const candidate of toEmails) {
    const token = parseSubAddressToken(candidate);
    if (!token) continue;
    const tokenRow = await resolveLeadFormSubmissionToken(token);
    if (!tokenRow) continue;
    leadFormAttribution = {
      token: tokenRow.token,
      probeId: tokenRow.probeId,
      targetId: tokenRow.targetId,
      entitySlug: tokenRow.entitySlug,
    };
    break; // first matching token wins
  }
  let bodyText = data.text ?? null;
  let bodyHtml = data.html ?? null;

  // Resend's email.received webhook payload is intentionally thin:
  // it leaves out the body (only ships a raw.download_url) AND it
  // strips most RFC headers — empirically `headers` arrives empty
  // for inbound and the parsed `data.in_reply_to` / `data.message_id`
  // are absent. The full email lives behind the REST endpoint
  // GET /emails/receiving/{id}. We pull it once for inbound events
  // and use it as the source of truth for body, Message-ID, and
  // In-Reply-To. Outbound delivery events (sent / delivered / etc.)
  // skip this fetch — those don't write threads.
  let restMessageId: string | null = null;
  let restInReplyTo: string | null = null;
  let restReferences: string | null = null;
  if (envelope.type === 'email.received' && data.email_id && process.env.RESEND_API_KEY) {
    try {
      const res = await fetch(
        `https://api.resend.com/emails/receiving/${data.email_id}`,
        { headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}` } },
      );
      if (res.ok) {
        const full = (await res.json()) as {
          text?: string;
          html?: string;
          headers?: ResendHeadersField;
          message_id?: string;
          in_reply_to?: string;
          references?: string;
        };
        bodyText = bodyText ?? full.text ?? null;
        bodyHtml = bodyHtml ?? full.html ?? null;
        restMessageId =
          full.message_id ?? pickHeader(full.headers, 'Message-ID') ?? null;
        restInReplyTo =
          full.in_reply_to ?? pickHeader(full.headers, 'In-Reply-To') ?? null;
        restReferences =
          full.references ?? pickHeader(full.headers, 'References') ?? null;
      }
    } catch (err) {
      console.warn('[resend-inbound] full-email fetch failed', err);
    }
  }

  // Resolve Message-ID and In-Reply-To with cascading fallbacks:
  // REST first (only place inbound headers actually live), then
  // top-level webhook fields, then webhook headers map (legacy
  // shape), then References tail. References' last <id@host> token
  // IS the immediate parent per RFC 5322 §3.6.4 — used when an
  // upstream relay strips In-Reply-To but keeps References.
  const messageId =
    restMessageId ??
    data.message_id ??
    pickHeader(data.headers, 'Message-ID') ??
    null;
  const inReplyTo =
    restInReplyTo ??
    data.in_reply_to ??
    pickHeader(data.headers, 'In-Reply-To') ??
    lastReferenceId(restReferences ?? data.references ?? pickHeader(data.headers, 'References')) ??
    null;
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
  // findThreadIdByInReplyTo normalizes angle brackets / case /
  // whitespace before lookup — different mail relays format
  // In-Reply-To inconsistently and exact-match was missing the
  // outbound's stored Message-ID.
  let threadId = await findThreadIdByInReplyTo(inReplyTo);
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

  // Step 5: insert message + event + touchpoint. Both Message-ID
  // fields go in normalized so a later reply-to-this-reply can find
  // its parent without bracket / case mismatches.
  const newMessageId = createId();

  // Detect language + translate to English when the inbound isn't
  // already English. Single Haiku call; capped at 4000 chars; never
  // throws (returns null on any failure). Stored alongside the
  // verbatim body in metadata so the inbox UI can render the EN
  // version by default with a "Translated from …" toggle to flip
  // back to the original.
  const translation = await translateInboundMessage({
    body: bodyText ?? bodyHtml?.slice(0, 4000) ?? '',
    subject,
  });

  // Lead-form-attributed inbound: upsert conversation_settings on
  // the sender's email so the reply path inherits the originating
  // probe's persona (alias + signature flow through, formality +
  // domain hint flow through customPrompt). Mirrors what the
  // autopilot does at first-touch for email recipients — for
  // lead_form there's no first-touch conversation_settings (form
  // submissions are outbound-only), so this inbound is the FIRST
  // moment we have a recipient email to key on.
  if (leadFormAttribution && fromEmail) {
    try {
      const [probeRow] = await db
        .select({
          alias: marketProbes.alias,
          formalityLevel: marketProbes.formalityLevel,
          domainHint: marketProbes.domainHint,
          outreachLanguage: marketProbes.outreachLanguage,
          tier: marketProbes.tier,
        })
        .from(marketProbes)
        .where(eq(marketProbes.id, leadFormAttribution.probeId))
        .limit(1);
      if (probeRow) {
        const formality =
          probeRow.formalityLevel === 'high' ||
          probeRow.formalityLevel === 'professional' ||
          probeRow.formalityLevel === 'casual'
            ? probeRow.formalityLevel
            : null;
        const customPromptParts: string[] = [];
        const fg = probeFormalityGuidance(formality);
        if (fg) {
          customPromptParts.push(`Formality: ${formality?.toUpperCase()} — ${fg}`);
        }
        const dh = probeDomainHintGuidance(probeRow.domainHint);
        if (dh) customPromptParts.push(`Domain framing: ${dh}`);
        const customPrompt =
          customPromptParts.length > 0
            ? customPromptParts.join('\n')
            : null;
        await db
          .insert(conversationSettings)
          .values({
            channel: 'email',
            conversationKey: fromEmail,
            aiEnabled: true,
            authority: 'chitchat_only',
            approvalMode: probeRow.tier >= 3 ? 'full_approval' : 'tiered',
            tone: 'brokerage_direct',
            language: probeRow.outreachLanguage ?? 'auto',
            identityDisclosure: 'on_request',
            linkedProbeId: leadFormAttribution.probeId,
            linkedEntitySlug: leadFormAttribution.entitySlug,
            responseDelayMinSec: 0,
            responseDelayMaxSec: 0,
            maxTurns: 6,
            maxCostUsdCents: 100,
            maxDurationHours: 168,
            channelConfig: {
              source: 'lead_form_reply_attribution',
              token: leadFormAttribution.token,
            },
            ...(customPrompt ? { customPrompt } : {}),
          })
          .onConflictDoUpdate({
            target: [
              conversationSettings.channel,
              conversationSettings.conversationKey,
            ],
            set: {
              aiEnabled: sql`${conversationSettings.aiEnabled} OR true`,
              linkedProbeId: leadFormAttribution.probeId,
              linkedEntitySlug: sql`COALESCE(${conversationSettings.linkedEntitySlug}, ${leadFormAttribution.entitySlug})`,
              ...(probeRow.outreachLanguage
                ? {
                    language: sql`CASE WHEN ${conversationSettings.language} = 'auto' THEN ${probeRow.outreachLanguage} ELSE ${conversationSettings.language} END`,
                  }
                : {}),
              ...(customPrompt
                ? {
                    customPrompt: sql`COALESCE(${conversationSettings.customPrompt}, ${customPrompt})`,
                  }
                : {}),
              updatedAt: new Date(),
            },
          });
      }
    } catch (err) {
      // Attribution upsert failure must NOT block the inbound. The
      // message still gets persisted; operator sees it without probe
      // linkage; manual recovery available.
      console.error(
        '[resend-inbound] lead-form attribution upsert failed',
        err,
        { token: leadFormAttribution.token },
      );
    }
  }

  await db.insert(messages).values({
    id: newMessageId,
    threadId,
    direction: 'inbound',
    subject: subject ?? null,
    fromEmail: fromEmail ?? null,
    messageId: normalizeRfcMessageId(messageId),
    inReplyTo: normalizeRfcMessageId(inReplyTo),
    metadata: {
      to: toEmails,
      body_text: bodyText?.slice(0, 64_000) ?? null,
      body_html: bodyHtml?.slice(0, 64_000) ?? null,
      contact_id: contactId,
      org_id: contactOrgId,
      provider_email_id: data.email_id ?? null,
      ...(leadFormAttribution
        ? {
            lead_form_attribution: {
              token: leadFormAttribution.token,
              probe_id: leadFormAttribution.probeId,
              target_id: leadFormAttribution.targetId,
              entity_slug: leadFormAttribution.entitySlug,
            },
          }
        : {}),
      ...(translation
        ? {
            detected_language_code: translation.detectedLanguageCode,
            detected_language_name: translation.detectedLanguageName,
            language_confidence: translation.confidence,
            ...(translation.translationEn
              ? { body_text_en: translation.translationEn }
              : {}),
            ...(translation.subjectTranslationEn
              ? { subject_en: translation.subjectTranslationEn }
              : {}),
          }
        : {}),
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

  // Conversation-agent auto-reply (Slice 3). Fire-and-forget — the
  // Anthropic draft call is multi-second and can stretch the
  // webhook past its provider deadline, which causes Resend / Svix
  // to retry the delivery and produces duplicate inbound rows. The
  // helper already swallows its own errors; the .catch is defensive
  // for a rejection that escapes its try/catch.
  void maybeQueueAiEmailReply({
    threadId,
    inboundMessageId: newMessageId,
    inboundFromEmail: fromEmail,
    inboundSubject: subject,
    inboundBodyText: bodyText,
    inboundBodyHtml: bodyHtml,
    inboundOccurredAt: occurredAt,
  }).catch((err) => {
    console.error('[resend-inbound] AI draft enqueue failed', err, {
      threadId,
      inboundMessageId: newMessageId,
    });
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
