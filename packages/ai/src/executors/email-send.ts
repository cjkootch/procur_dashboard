import { Resend } from 'resend';
import { desc, eq } from 'drizzle-orm';
import {
  approvals,
  companies,
  contacts,
  db,
  events,
  touchpoints,
} from '@procur/db';
import { createId } from '../agents/id';
import { PostgresCostLedger } from '../cost-ledger';

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
}

export interface EmailSendResult {
  ok: boolean;
  providerMessageId?: string;
  touchpointId?: string;
  error?: string;
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

  const headers: Record<string, string> = {};
  if (payload.inReplyTo) {
    headers['In-Reply-To'] = payload.inReplyTo;
    headers['References'] = payload.inReplyTo;
  }

  // Pull per-company email defaults set at /settings/email. Single-user
  // scope so we just take the first row; future multi-tenant lookup can
  // scope by approval.company_id.
  const companyRow = await db
    .select({
      displayName: companies.emailSenderDisplayName,
      alwaysCc: companies.emailAlwaysCc,
      signatureText: companies.emailSignatureText,
      signatureHtml: companies.emailSignatureHtml,
    })
    .from(companies)
    .orderBy(desc(companies.createdAt))
    .limit(1);
  const settings = companyRow[0];

  // Decorate the From header with display name when configured.
  const from = settings?.displayName
    ? `${settings.displayName} <${stripBrackets(FROM_DEFAULT)}>`
    : FROM_DEFAULT;

  // Append signature to body if configured.
  const bodyText = settings?.signatureText
    ? `${payload.body}\n\n--\n${settings.signatureText}`
    : payload.body;
  const bodyHtml = settings?.signatureHtml
    ? `<div>${escapeHtml(payload.body).replace(/\n/g, '<br>')}</div><br>${settings.signatureHtml}`
    : undefined;

  let providerMessageId: string;
  try {
    const sendArgs: Parameters<typeof resend.emails.send>[0] = {
      from,
      to: payload.to,
      subject: payload.subject,
      text: bodyText,
      headers: Object.keys(headers).length > 0 ? headers : undefined,
    };
    if (bodyHtml) sendArgs.html = bodyHtml;
    const cc = (settings?.alwaysCc ?? []).filter(
      (c): c is string => typeof c === 'string' && c.length > 0,
    );
    if (cc.length > 0) sendArgs.cc = cc;
    const result = await resend.emails.send(sendArgs, {
      idempotencyKey: `approval:${approvalId}`,
    });
    if (result.error) {
      return {
        ok: false,
        error: `Resend ${result.error.name ?? 'error'}: ${result.error.message ?? 'unknown'}`,
      };
    }
    if (!result.data?.id) {
      return { ok: false, error: 'Resend returned no message id' };
    }
    providerMessageId = result.data.id;
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }

  // Resolve the contact's primary org for the touchpoint org_id link.
  let orgIdForTouchpoint: string | null = null;
  if (payload.contactId) {
    const contactRow = await db
      .select({ orgId: contacts.orgId })
      .from(contacts)
      .where(eq(contacts.id, payload.contactId))
      .limit(1);
    orgIdForTouchpoint = contactRow[0]?.orgId ?? null;
  }

  const touchpointId = createId();
  const occurredAt = new Date();
  await db.insert(touchpoints).values({
    id: touchpointId,
    channel: 'email.sent',
    actor: `approval:${approvalId}`,
    occurredAt,
    contactId: payload.contactId ?? null,
    orgId: orgIdForTouchpoint,
    metadata: {
      provider_message_id: providerMessageId,
      to: payload.to,
      subject: payload.subject,
      in_reply_to: payload.inReplyTo ?? null,
      template_name: payload.templateName ?? null,
      lang: payload.lang ?? null,
    },
  });

  // Cost ledger — one entry per recipient (Resend bills per email).
  // Stub price 0.0001 USD per send; real provider invoicing reconciles
  // on the rollup. Idempotency key per (approval, recipient) so retries
  // don't double-charge.
  const costPerSendMicros = 100; // 0.0001 USD
  for (const recipient of payload.to) {
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

  // Audit event.
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
      objectId: providerMessageId,
      occurredAt,
      idempotencyKey: `email.sent:${approvalId}`,
      metadata: {
        provider_message_id: providerMessageId,
        recipient_count: payload.to.length,
      },
    })
    .onConflictDoNothing({
      target: [events.occurredAt, events.idempotencyKey],
    });

  // Stamp applied_object_id + applied_at on the approval.
  await db
    .update(approvals)
    .set({
      appliedObjectId: touchpointId,
      appliedAt: occurredAt,
    })
    .where(eq(approvals.id, approvalId));

  return { ok: true, providerMessageId, touchpointId };
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

