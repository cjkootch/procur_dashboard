import { Resend } from 'resend';
import { desc, eq, sql } from 'drizzle-orm';
import {
  approvals,
  companies,
  contacts,
  db,
  events,
  messages,
  threads,
  touchpoints,
} from '@procur/db';
import { createId } from '../agents/id';
import type { MlEvidenceT } from '../agents/action-descriptor';
import { PostgresCostLedger } from '../cost-ledger';
import {
  buildOutreachMetadata,
  emitOutreachSent,
  parseOutreachEvidence,
  type OutreachEvidence,
} from './outreach-evidence';

/**
 * email.send executor — closes the Phase 2 approval-queue loop.
 *
 * When an `email.send` approval flips to `approved` (or `auto_approved`),
 * call this. It verifies the payload, dispatches via Resend with proper
 * RFC-5322 threading headers (In-Reply-To / References), writes an
 * `email.sent` touchpoint, records the per-recipient cost ledger entry,
 * and stamps `applied_object_id` + `applied_at` on the approval row.
 *
 * Phase 0 / Phase 2 decisions applied:
 *   - Inline dispatch (no queue worker — Trigger.dev v3→v4 is gated;
 *     single-user latency is acceptable). Phase 4+ can move this to
 *     a worker without changing the function shape.
 *   - Idempotent: if applied_at is already set on the approval, the
 *     executor is a no-op. The Resend idempotency key is the approval
 *     id so retries can't double-send.
 *   - Fail loudly on Resend errors so the operator sees the failure
 *     in the UI (the calling server action surfaces it).
 */

let resendClient: Resend | null = null;
function getResend(): Resend {
  if (!resendClient) {
    if (!process.env.RESEND_API_KEY) {
      throw new Error('RESEND_API_KEY is not set');
    }
    resendClient = new Resend(process.env.RESEND_API_KEY);
  }
  return resendClient;
}

const FROM_DEFAULT =
  process.env.RESEND_FROM_ADDRESS ?? 'Procur <hey@hey.procur.app>';

export interface EmailSendPayload {
  to: string[];
  subject: string;
  body: string;
  inReplyTo?: string;
  contactId?: string;
  /** Optional template name for the audit trail / chip preview. */
  templateName?: string;
  /** Optional language tag (ISO 639-1). Display-only. */
  lang?: string;
  /** Operator rationale captured at proposal time. */
  rationale?: string;
  /** Recommendation-pipeline evidence pack (see ../agents/action-descriptor.ts).
   *  Preserved into touchpoints + emitted as `outreach.sent` event so
   *  outcome-time joins can pivot back to the model that produced the
   *  send. */
  evidenceJson?: Record<string, unknown>;
  mlEvidence?: MlEvidenceT;
  sourceEntitySlug?: string;
  sourceSignalId?: string;
  sourceOpportunityId?: string;
  riskWarnings?: string[];
  doNotMention?: string[];
}

export interface EmailSendResult {
  ok: boolean;
  providerMessageId?: string;
  touchpointId?: string;
  error?: string;
}

export interface EmailSendOptions {
  /**
   * Explicit company id whose `/settings/email` defaults should
   * decorate this send. The dispatcher resolves this from the
   * approver's `users.companyId`. When omitted (e.g. legacy callers
   * or background jobs without a user context), the executor falls
   * back to the most-recently-created company row — single-tenant
   * compatible but a leak the moment a second tenant exists.
   */
  companyId?: string;
  /**
   * Per-probe outreach identity override. When the calling autopilot
   * dispatches from a probe with `alias` / `email_signature_*` set,
   * those values ride here and replace the company-level defaults.
   * The underlying From address still comes from the company-level
   * Resend setup; only the display name + signature shift per probe.
   * NULL fields fall back to the company defaults (existing
   * behavior — preserves zero-impact for probes that don't set
   * these). */
  probeIdentity?: {
    alias?: string | null;
    emailSignatureText?: string | null;
    emailSignatureHtml?: string | null;
  };
}

const costLedger = new PostgresCostLedger();

/**
 * Apply an approved email.send action. Returns success + provider id
 * on dispatch; otherwise an error string. Writes the touchpoint and
 * cost-ledger entries on success only.
 */
export async function applyEmailSend(
  approvalId: string,
  payload: EmailSendPayload,
  options: EmailSendOptions = {},
): Promise<EmailSendResult> {
  if (!Array.isArray(payload.to) || payload.to.length === 0) {
    return { ok: false, error: 'email.send payload missing recipients' };
  }
  if (!payload.subject?.trim()) {
    return { ok: false, error: 'email.send payload missing subject' };
  }
  if (!payload.body?.trim()) {
    return { ok: false, error: 'email.send payload missing body' };
  }

  // Short-circuit if the approval has already been applied.
  const existing = await db
    .select({ appliedAt: approvals.appliedAt })
    .from(approvals)
    .where(eq(approvals.id, approvalId))
    .limit(1);
  if (existing[0]?.appliedAt) {
    return { ok: true };
  }

  let resend: Resend;
  try {
    resend = getResend();
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }

  // RFC-5322 threading. inReplyTo carries the parent message's
  // Message-ID header (NOT a procur DB id) — the inbound resend
  // webhook resolves replies via `messages.message_id = inReplyTo`,
  // so symmetric outbound MUST set the same shape on replies and
  // on first-touch sends. Headers attach to every fan-out.
  const inReplyToHeaders: Record<string, string> = {};
  if (payload.inReplyTo) {
    inReplyToHeaders['In-Reply-To'] = payload.inReplyTo;
    inReplyToHeaders['References'] = payload.inReplyTo;
  }

  // Domain for our generated Message-IDs. Pulled from FROM_DEFAULT
  // so the domain matches the Sent-from address and looks legit to
  // recipients' MTAs (Gmail spam-checks Message-ID host alignment).
  const fromAddrOnly = stripBrackets(FROM_DEFAULT);
  const messageIdDomain = fromAddrOnly.split('@')[1] ?? 'procur.app';

  // Pull per-company email defaults set at /settings/email. Prefer
  // the explicit companyId from the dispatcher (resolved from the
  // approver's users.companyId); fall back to most-recently-created
  // company only when no id is threaded through (legacy / background
  // dispatch paths). The fallback is safe single-tenant but leaks the
  // moment a second company exists, which is why the dispatcher
  // always passes the explicit id today.
  const companySelect = {
    displayName: companies.emailSenderDisplayName,
    alwaysCc: companies.emailAlwaysCc,
    signatureText: companies.emailSignatureText,
    signatureHtml: companies.emailSignatureHtml,
  };
  const companyRow = options.companyId
    ? await db
        .select(companySelect)
        .from(companies)
        .where(eq(companies.id, options.companyId))
        .limit(1)
    : await db
        .select(companySelect)
        .from(companies)
        .orderBy(desc(companies.createdAt))
        .limit(1);
  const settings = companyRow[0];

  // Per-probe identity overrides take precedence over company-level
  // defaults when the autopilot dispatches from a probe. Only the
  // display name + signature shift per probe; the underlying From
  // address stays the company-default Resend address (no per-probe
  // DNS / identity verification needed).
  const displayName =
    options.probeIdentity?.alias ?? settings?.displayName ?? null;
  const signatureText =
    options.probeIdentity?.emailSignatureText ??
    settings?.signatureText ??
    null;
  const signatureHtml =
    options.probeIdentity?.emailSignatureHtml ??
    settings?.signatureHtml ??
    null;

  // Decorate the From header with display name when configured.
  const from = displayName
    ? `${displayName} <${stripBrackets(FROM_DEFAULT)}>`
    : FROM_DEFAULT;

  // Append signature to body if configured.
  const bodyText = signatureText
    ? `${payload.body}\n\n--\n${signatureText}`
    : payload.body;
  const bodyHtml = signatureHtml
    ? `<div>${escapeHtml(payload.body).replace(/\n/g, '<br>')}</div><br>${signatureHtml}`
    : undefined;

  // Resolve the contact's primary org once so each per-recipient
  // touchpoint can carry the org link.
  let orgIdForTouchpoint: string | null = null;
  if (payload.contactId) {
    const contactRow = await db
      .select({ orgId: contacts.orgId })
      .from(contacts)
      .where(eq(contacts.id, payload.contactId))
      .limit(1);
    orgIdForTouchpoint = contactRow[0]?.orgId ?? null;
  }

  // Recommendation-pipeline evidence — populated when the chat
  // assistant proposed via `recommend_outreach_targets` +
  // `draft_outreach_from_intelligence`; empty for manual sends.
  const payloadEvidence: OutreachEvidence = {
    ...(payload.evidenceJson ? { evidenceJson: payload.evidenceJson } : {}),
    ...(payload.mlEvidence ? { mlEvidence: payload.mlEvidence } : {}),
    ...(payload.sourceEntitySlug
      ? { sourceEntitySlug: payload.sourceEntitySlug }
      : {}),
    ...(payload.sourceSignalId
      ? { sourceSignalId: payload.sourceSignalId }
      : {}),
    ...(payload.sourceOpportunityId
      ? { sourceOpportunityId: payload.sourceOpportunityId }
      : {}),
    ...(payload.riskWarnings ? { riskWarnings: payload.riskWarnings } : {}),
    ...(payload.doNotMention ? { doNotMention: payload.doNotMention } : {}),
  };

  // Fan out one Resend send per recipient. Sending all addresses in
  // a single Resend `to: [...]` would expose every recipient's address
  // to every other recipient via the To: header — for outreach to
  // counterparties this is a privacy leak (and looks unprofessional).
  // Per-recipient idempotency keys mean a retry after a partial
  // failure won't re-send to addresses that already succeeded.
  const cc = (settings?.alwaysCc ?? []).filter(
    (c): c is string => typeof c === 'string' && c.length > 0,
  );
  const costPerSendMicros = 100; // 0.0001 USD stub
  const occurredAt = new Date();
  const providerMessageIds: string[] = [];
  let firstTouchpointId: string | undefined;

  for (const recipient of payload.to) {
    // Generate our own RFC-5322 Message-ID before sending so we can
    // (a) tell Resend to use it on the wire (lets us correlate the
    // recipient's eventual reply via In-Reply-To), and (b) store it
    // in messages.message_id for the inbound webhook to resolve back
    // to this thread.
    const rfcMessageId = `<${createId()}@${messageIdDomain}>`;
    const sendHeaders: Record<string, string> = {
      ...inReplyToHeaders,
      'Message-ID': rfcMessageId,
    };

    const sendArgs: Parameters<typeof resend.emails.send>[0] = {
      from,
      to: [recipient],
      subject: payload.subject,
      text: bodyText,
      headers: sendHeaders,
    };
    if (bodyHtml) sendArgs.html = bodyHtml;
    if (cc.length > 0) sendArgs.cc = cc;

    let providerMessageId: string;
    try {
      const result = await resend.emails.send(sendArgs, {
        idempotencyKey: `approval:${approvalId}:${recipient}`,
      });
      if (result.error) {
        return {
          ok: false,
          error: `Resend ${result.error.name ?? 'error'} for ${recipient}: ${result.error.message ?? 'unknown'}`,
          providerMessageId: providerMessageIds[0],
        };
      }
      if (!result.data?.id) {
        return {
          ok: false,
          error: `Resend returned no message id for ${recipient}`,
          providerMessageId: providerMessageIds[0],
        };
      }
      providerMessageId = result.data.id;
    } catch (err) {
      return {
        ok: false,
        error: `${recipient}: ${(err as Error).message}`,
        providerMessageId: providerMessageIds[0],
      };
    }
    providerMessageIds.push(providerMessageId);

    // Resolve the thread for this recipient. If we're replying
    // (inReplyTo set), look up the parent message and reuse its
    // thread; otherwise create a fresh thread per recipient so each
    // counterparty conversation is its own row. Mirrors the inbound
    // webhook's resolve-or-create pattern (route.ts:222-244).
    //
    // Lookup tolerates angle-bracket / case / whitespace variation
    // because different mail relays format Message-ID strings
    // inconsistently — exact match was missing the parent. See
    // packages/catalog/src/inbox.ts:normalizeRfcMessageId for the
    // canonical normalization (kept in sync inline here so this
    // executor doesn't need to import @procur/catalog and risk a
    // circular dep with @procur/ai).
    let threadId: string | null = null;
    const normalizedInReplyTo = payload.inReplyTo
      ? payload.inReplyTo
          .trim()
          .split(/\s+/)[0]!
          .replace(/^<+/, '')
          .replace(/>+$/, '')
          .toLowerCase()
      : null;
    if (normalizedInReplyTo) {
      const legacyBracketed = `<${normalizedInReplyTo}>`;
      const parent = await db
        .select({ threadId: messages.threadId })
        .from(messages)
        .where(
          sql`${messages.messageId} = ${normalizedInReplyTo} OR ${messages.messageId} = ${legacyBracketed}`,
        )
        .limit(1);
      if (parent[0]) threadId = parent[0].threadId;
    }
    if (!threadId) {
      threadId = createId();
      await db.insert(threads).values({
        id: threadId,
        channel: 'email',
        subject: payload.subject,
        participantIds: payload.contactId ? [payload.contactId] : [],
        lastMessageAt: occurredAt,
      });
    } else {
      await db
        .update(threads)
        .set({ lastMessageAt: occurredAt })
        .where(eq(threads.id, threadId));
    }

    // Write the outbound message row with the normalized form of our
    // generated Message-ID — bracket-less + lowercase — so a future
    // inbound reply can resolve back to this thread regardless of how
    // its mail relay formatted the In-Reply-To header. The wire
    // header (sendHeaders['Message-ID']) keeps the canonical
    // <id@host> form per RFC 5322.
    const normalizedRfcMessageId = rfcMessageId
      .trim()
      .replace(/^<+/, '')
      .replace(/>+$/, '')
      .toLowerCase();
    await db.insert(messages).values({
      id: createId(),
      threadId,
      direction: 'outbound',
      subject: payload.subject,
      fromEmail: fromAddrOnly,
      messageId: normalizedRfcMessageId,
      inReplyTo: normalizedInReplyTo,
      metadata: {
        to: [recipient],
        cc,
        body_text: bodyText.slice(0, 64_000),
        body_html: bodyHtml ? bodyHtml.slice(0, 64_000) : null,
        contact_id: payload.contactId ?? null,
        org_id: orgIdForTouchpoint,
        provider_email_id: providerMessageId,
        approval_id: approvalId,
        template_name: payload.templateName ?? null,
      },
    });

    const touchpointId = createId();
    if (!firstTouchpointId) firstTouchpointId = touchpointId;
    await db.insert(touchpoints).values({
      id: touchpointId,
      channel: 'email.sent',
      actor: `approval:${approvalId}`,
      occurredAt,
      contactId: payload.contactId ?? null,
      orgId: orgIdForTouchpoint,
      metadata: {
        provider_message_id: providerMessageId,
        rfc_message_id: rfcMessageId,
        thread_id: threadId,
        to: recipient,
        subject: payload.subject,
        in_reply_to: payload.inReplyTo ?? null,
        template_name: payload.templateName ?? null,
        lang: payload.lang ?? null,
        // Recommendation-pipeline evidence preserved on every touchpoint
        // so we can join evidence ↔ outreach.replied / converted_to_deal
        // outcomes. No-op for manual operator-driven sends.
        ...buildOutreachMetadata(payloadEvidence),
      },
    });

    await costLedger.record({
      idempotencyKey: `email.send:${approvalId}:${recipient}`,
      operation: 'email.send',
      provider: 'resend',
      units: 1,
      unitKind: 'emails',
      costUsdMicros: costPerSendMicros,
      occurredAt,
    });
  }

  // Single audit event covering the whole approval. Object id is the
  // first message id (back-compat with single-recipient consumers);
  // metadata carries the full set so audit history is complete.
  await db
    .insert(events)
    .values({
      id: createId(),
      verb: 'email.sent',
      subjectType: 'approval',
      subjectId: approvalId,
      actorType: 'system',
      actorId: 'email-send-executor',
      objectType: 'message',
      objectId: providerMessageIds[0] ?? approvalId,
      occurredAt,
      idempotencyKey: `email.sent:${approvalId}`,
      metadata: {
        provider_message_ids: providerMessageIds,
        recipient_count: payload.to.length,
        ...buildOutreachMetadata(payloadEvidence),
      },
    })
    .onConflictDoNothing({
      target: [events.occurredAt, events.idempotencyKey],
    });

  // Recommendation-pipeline lifecycle event. No-op for manual sends.
  await emitOutreachSent({
    approvalId,
    channel: 'email',
    evidence: payloadEvidence,
    occurredAt,
    ...(providerMessageIds[0]
      ? { providerObjectId: providerMessageIds[0] }
      : {}),
  });

  await db
    .update(approvals)
    .set({
      appliedObjectId: firstTouchpointId ?? null,
      appliedAt: occurredAt,
    })
    .where(eq(approvals.id, approvalId));

  return {
    ok: true,
    providerMessageId: providerMessageIds[0],
    touchpointId: firstTouchpointId,
  };
}

/**
 * Cast the JSONB proposed_payload into the email.send shape.
 * Returns null if it doesn't look like a valid email.send.
 */
export function parseEmailSendPayload(
  proposedPayload: Record<string, unknown> | null | undefined,
): EmailSendPayload | null {
  if (!proposedPayload || typeof proposedPayload !== 'object') return null;
  const to = proposedPayload['to'];
  if (!Array.isArray(to) || !to.every((t) => typeof t === 'string')) {
    return null;
  }
  const subject = proposedPayload['subject'];
  const body = proposedPayload['body'];
  if (typeof subject !== 'string' || typeof body !== 'string') return null;
  const result: EmailSendPayload = { to: to as string[], subject, body };
  if (typeof proposedPayload['inReplyTo'] === 'string') {
    result.inReplyTo = proposedPayload['inReplyTo'] as string;
  }
  if (typeof proposedPayload['contactId'] === 'string') {
    result.contactId = proposedPayload['contactId'] as string;
  }
  if (typeof proposedPayload['templateName'] === 'string') {
    result.templateName = proposedPayload['templateName'] as string;
  }
  if (typeof proposedPayload['lang'] === 'string') {
    result.lang = proposedPayload['lang'] as string;
  }
  if (typeof proposedPayload['rationale'] === 'string') {
    result.rationale = proposedPayload['rationale'] as string;
  }
  // Recommendation-pipeline evidence fields. The shared parser
  // returns an empty struct when the descriptor was operator-authored;
  // anything it finds gets copied through.
  const evidence = parseOutreachEvidence(proposedPayload);
  if (evidence.evidenceJson) result.evidenceJson = evidence.evidenceJson;
  if (evidence.mlEvidence) result.mlEvidence = evidence.mlEvidence;
  if (evidence.sourceEntitySlug) result.sourceEntitySlug = evidence.sourceEntitySlug;
  if (evidence.sourceSignalId) result.sourceSignalId = evidence.sourceSignalId;
  if (evidence.sourceOpportunityId)
    result.sourceOpportunityId = evidence.sourceOpportunityId;
  if (evidence.riskWarnings) result.riskWarnings = evidence.riskWarnings;
  if (evidence.doNotMention) result.doNotMention = evidence.doNotMention;
  return result;
}

/** Strip a "Name <addr>" envelope to just `addr`. */
function stripBrackets(addr: string): string {
  const m = addr.match(/<([^>]+)>/);
  return (m?.[1] ?? addr).trim();
}

/** Minimal HTML-escape for plain-text bodies appended into HTML email. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

