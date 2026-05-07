import twilio from 'twilio';
import { eq } from 'drizzle-orm';
import {
  approvals,
  contacts,
  db,
  events,
  organizations,
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
 * Optional ML-evidence fields shared across the SMS / WhatsApp /
 * voice payloads. Populated when the chat assistant proposed via
 * the recommendation pipeline (recommend_outreach_targets +
 * draft_outreach_from_intelligence); empty for manual operator
 * sends. Preserved into touchpoints + emitted as `outreach.sent`
 * when the executor dispatches.
 */
interface OutreachEvidenceFields {
  evidenceJson?: Record<string, unknown>;
  mlEvidence?: MlEvidenceT;
  sourceEntitySlug?: string;
  sourceSignalId?: string;
  sourceOpportunityId?: string;
  riskWarnings?: string[];
  doNotMention?: string[];
}

function pickEvidence(input: OutreachEvidenceFields): OutreachEvidence {
  return {
    ...(input.evidenceJson ? { evidenceJson: input.evidenceJson } : {}),
    ...(input.mlEvidence ? { mlEvidence: input.mlEvidence } : {}),
    ...(input.sourceEntitySlug
      ? { sourceEntitySlug: input.sourceEntitySlug }
      : {}),
    ...(input.sourceSignalId
      ? { sourceSignalId: input.sourceSignalId }
      : {}),
    ...(input.sourceOpportunityId
      ? { sourceOpportunityId: input.sourceOpportunityId }
      : {}),
    ...(input.riskWarnings ? { riskWarnings: input.riskWarnings } : {}),
    ...(input.doNotMention ? { doNotMention: input.doNotMention } : {}),
  };
}

function copyEvidenceFromPayload(
  proposedPayload: Record<string, unknown>,
  out: OutreachEvidenceFields,
): void {
  const evidence = parseOutreachEvidence(proposedPayload);
  if (evidence.evidenceJson) out.evidenceJson = evidence.evidenceJson;
  if (evidence.mlEvidence) out.mlEvidence = evidence.mlEvidence;
  if (evidence.sourceEntitySlug)
    out.sourceEntitySlug = evidence.sourceEntitySlug;
  if (evidence.sourceSignalId) out.sourceSignalId = evidence.sourceSignalId;
  if (evidence.sourceOpportunityId)
    out.sourceOpportunityId = evidence.sourceOpportunityId;
  if (evidence.riskWarnings) out.riskWarnings = evidence.riskWarnings;
  if (evidence.doNotMention) out.doNotMention = evidence.doNotMention;
}

/**
 * Twilio executors per docs/vex-into-procur-merge-brief.md Phase 7.
 * Closes the Phase 2 approval-queue loop for SMS, WhatsApp, and
 * outbound voice calls.
 *
 * Two voice modes per the `aiMode` flag on the action payload:
 *   aiMode=false (default) — Twilio dials, plays a brief intro, joins
 *     the recipient + operator in a conference room.
 *   aiMode=true — Twilio dials and connects to procur's voice-bridge
 *     (Phase 7.5 Fly app at procur-voice-bridge.fly.dev) which
 *     shuttles audio to OpenAI Realtime for full AI talkback.
 *
 * Both modes run through this same executor — the TwiML route picks
 * the right verb based on `?mode=ai|conference`.
 *
 * Phase 0 / 2 decisions applied: inline dispatch, idempotent on
 * approval.applied_at, fail-loud on Twilio API errors so the
 * approval UI surfaces the failure.
 */

let twilioClient: ReturnType<typeof twilio> | null = null;
function getTwilio(): ReturnType<typeof twilio> {
  if (!twilioClient) {
    const sid = process.env.TWILIO_ACCOUNT_SID;
    const apiKey = process.env.TWILIO_API_KEY;
    const apiSecret = process.env.TWILIO_API_SECRET;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    if (!sid) throw new Error('TWILIO_ACCOUNT_SID not configured');
    // Prefer API key auth (TWILIO_API_KEY + TWILIO_API_SECRET); fall
    // back to auth-token for back-compat.
    if (apiKey && apiSecret) {
      twilioClient = twilio(apiKey, apiSecret, { accountSid: sid });
    } else if (authToken) {
      twilioClient = twilio(sid, authToken);
    } else {
      throw new Error(
        'Twilio auth not configured: set TWILIO_API_KEY + TWILIO_API_SECRET, or TWILIO_AUTH_TOKEN',
      );
    }
  }
  return twilioClient;
}

const FROM_PHONE = process.env.TWILIO_PHONE_NUMBER;
const FROM_WHATSAPP =
  process.env.TWILIO_WHATSAPP_FROM ??
  (FROM_PHONE ? `whatsapp:${FROM_PHONE}` : null);
const APP_URL =
  process.env.NEXT_PUBLIC_APP_URL ?? 'https://app.procur.app';

interface ExecutorResult {
  ok: boolean;
  appliedObjectId?: string;
  error?: string;
}

const costLedger = new PostgresCostLedger();

async function alreadyApplied(approvalId: string): Promise<boolean> {
  const rows = await db
    .select({ appliedAt: approvals.appliedAt })
    .from(approvals)
    .where(eq(approvals.id, approvalId))
    .limit(1);
  return rows[0]?.appliedAt != null;
}

async function resolveContactOrg(
  contactId: string | undefined,
): Promise<{ contactId: string; orgId: string | null } | null> {
  if (!contactId) return null;
  const rows = await db
    .select({ contactId: contacts.id, orgId: contacts.orgId })
    .from(contacts)
    .where(eq(contacts.id, contactId))
    .limit(1);
  return rows[0] ?? null;
}

// ============================================================================
// sms.send
// ============================================================================

export interface SmsSendPayload extends OutreachEvidenceFields {
  to: string;
  body: string;
  contactId?: string;
  templateName?: string;
  rationale: string;
}

export function parseSmsSendPayload(
  proposedPayload: Record<string, unknown> | null | undefined,
): SmsSendPayload | null {
  if (!proposedPayload || typeof proposedPayload !== 'object') return null;
  const to = proposedPayload['to'];
  const body = proposedPayload['body'];
  const rationale = proposedPayload['rationale'];
  if (
    typeof to !== 'string' ||
    typeof body !== 'string' ||
    typeof rationale !== 'string'
  ) {
    return null;
  }
  const out: SmsSendPayload = { to, body, rationale };
  if (typeof proposedPayload['contactId'] === 'string') {
    out.contactId = proposedPayload['contactId'] as string;
  }
  if (typeof proposedPayload['templateName'] === 'string') {
    out.templateName = proposedPayload['templateName'] as string;
  }
  copyEvidenceFromPayload(proposedPayload, out);
  return out;
}

export async function applySmsSend(
  approvalId: string,
  payload: SmsSendPayload,
): Promise<ExecutorResult> {
  if (await alreadyApplied(approvalId)) return { ok: true };
  if (!FROM_PHONE) {
    return { ok: false, error: 'TWILIO_PHONE_NUMBER not configured' };
  }
  let messageSid: string;
  let segments: number;
  try {
    const client = getTwilio();
    const message = await client.messages.create({
      from: FROM_PHONE,
      to: payload.to,
      body: payload.body,
    });
    messageSid = message.sid;
    segments = Number(message.numSegments ?? 1);
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
  const evidence = pickEvidence(payload);
  const evidenceMeta = buildOutreachMetadata(evidence);
  await writeOutboundTouchpoint(approvalId, 'sms.sent', payload.contactId, {
    provider_message_id: messageSid,
    to: payload.to,
    template_name: payload.templateName ?? null,
    body_preview: payload.body.slice(0, 240),
    segments,
    ...evidenceMeta,
  });
  // Cost ledger — Twilio bills per SMS segment; stub at $0.0079/segment.
  await costLedger.record({
    idempotencyKey: `sms.send:${approvalId}`,
    operation: 'sms.send',
    provider: 'twilio',
    units: segments,
    unitKind: 'segments',
    costUsdMicros: segments * 7900,
    occurredAt: new Date(),
  });
  const result = await stampApplied(approvalId, messageSid, 'sms.sent', {
    to: payload.to,
    segments,
    ...evidenceMeta,
  });
  await emitOutreachSent({
    approvalId,
    channel: 'sms',
    evidence,
    occurredAt: new Date(),
    providerObjectId: messageSid,
  });
  return result;
}

// ============================================================================
// whatsapp.send (freeform within 24h conversation window)
// ============================================================================

export interface WhatsAppSendPayload extends OutreachEvidenceFields {
  to: string;
  body: string;
  contactId?: string;
  templateName?: string;
  rationale: string;
}

export function parseWhatsAppSendPayload(
  proposedPayload: Record<string, unknown> | null | undefined,
): WhatsAppSendPayload | null {
  // SMS + WhatsApp share the same field shape — including evidence.
  return parseSmsSendPayload(proposedPayload);
}

export async function applyWhatsAppSend(
  approvalId: string,
  payload: WhatsAppSendPayload,
): Promise<ExecutorResult> {
  if (await alreadyApplied(approvalId)) return { ok: true };
  if (!FROM_WHATSAPP) {
    return {
      ok: false,
      error:
        'TWILIO_WHATSAPP_FROM not configured (set explicitly or set TWILIO_PHONE_NUMBER)',
    };
  }
  let messageSid: string;
  try {
    const client = getTwilio();
    const message = await client.messages.create({
      from: FROM_WHATSAPP,
      to: `whatsapp:${payload.to}`,
      body: payload.body,
    });
    messageSid = message.sid;
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
  const evidence = pickEvidence(payload);
  const evidenceMeta = buildOutreachMetadata(evidence);
  await writeOutboundTouchpoint(
    approvalId,
    'whatsapp.sent',
    payload.contactId,
    {
      provider_message_id: messageSid,
      to: payload.to,
      template_name: payload.templateName ?? null,
      body_preview: payload.body.slice(0, 240),
      ...evidenceMeta,
    },
  );
  await costLedger.record({
    idempotencyKey: `whatsapp.send:${approvalId}`,
    operation: 'whatsapp.send',
    provider: 'twilio',
    units: 1,
    unitKind: 'messages',
    // WhatsApp pricing is conversation-based; rough $0.0085/msg stub.
    costUsdMicros: 8500,
    occurredAt: new Date(),
  });
  const result = await stampApplied(approvalId, messageSid, 'whatsapp.sent', {
    to: payload.to,
    ...evidenceMeta,
  });
  await emitOutreachSent({
    approvalId,
    channel: 'whatsapp',
    evidence,
    occurredAt: new Date(),
    providerObjectId: messageSid,
  });
  return result;
}

// ============================================================================
// whatsapp.send_template
// ============================================================================

export interface WhatsAppSendTemplatePayload extends OutreachEvidenceFields {
  to: string;
  contentSid: string;
  contentVariables?: Record<string, string>;
  templateName?: string;
  contactId?: string;
  rationale: string;
}

export function parseWhatsAppSendTemplatePayload(
  proposedPayload: Record<string, unknown> | null | undefined,
): WhatsAppSendTemplatePayload | null {
  if (!proposedPayload || typeof proposedPayload !== 'object') return null;
  const to = proposedPayload['to'];
  const contentSid = proposedPayload['contentSid'];
  const rationale = proposedPayload['rationale'];
  if (
    typeof to !== 'string' ||
    typeof contentSid !== 'string' ||
    typeof rationale !== 'string'
  ) {
    return null;
  }
  const out: WhatsAppSendTemplatePayload = { to, contentSid, rationale };
  if (
    proposedPayload['contentVariables'] &&
    typeof proposedPayload['contentVariables'] === 'object'
  ) {
    out.contentVariables = proposedPayload['contentVariables'] as Record<
      string,
      string
    >;
  }
  if (typeof proposedPayload['templateName'] === 'string') {
    out.templateName = proposedPayload['templateName'] as string;
  }
  if (typeof proposedPayload['contactId'] === 'string') {
    out.contactId = proposedPayload['contactId'] as string;
  }
  copyEvidenceFromPayload(proposedPayload, out);
  return out;
}

export async function applyWhatsAppSendTemplate(
  approvalId: string,
  payload: WhatsAppSendTemplatePayload,
): Promise<ExecutorResult> {
  if (await alreadyApplied(approvalId)) return { ok: true };
  if (!FROM_WHATSAPP) {
    return { ok: false, error: 'TWILIO_WHATSAPP_FROM not configured' };
  }
  let messageSid: string;
  try {
    const client = getTwilio();
    const opts: Parameters<typeof client.messages.create>[0] = {
      from: FROM_WHATSAPP,
      to: `whatsapp:${payload.to}`,
      contentSid: payload.contentSid,
    };
    if (payload.contentVariables) {
      opts.contentVariables = JSON.stringify(payload.contentVariables);
    }
    const message = await client.messages.create(opts);
    messageSid = message.sid;
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
  const evidence = pickEvidence(payload);
  const evidenceMeta = buildOutreachMetadata(evidence);
  await writeOutboundTouchpoint(
    approvalId,
    'whatsapp.sent',
    payload.contactId,
    {
      provider_message_id: messageSid,
      to: payload.to,
      content_sid: payload.contentSid,
      template_name: payload.templateName ?? null,
      ...evidenceMeta,
    },
  );
  await costLedger.record({
    idempotencyKey: `whatsapp.send_template:${approvalId}`,
    operation: 'whatsapp.send_template',
    provider: 'twilio',
    units: 1,
    unitKind: 'messages',
    costUsdMicros: 8500,
    occurredAt: new Date(),
  });
  const result = await stampApplied(
    approvalId,
    messageSid,
    'whatsapp.sent',
    { to: payload.to, content_sid: payload.contentSid, ...evidenceMeta },
  );
  await emitOutreachSent({
    approvalId,
    channel: 'whatsapp_template',
    evidence,
    occurredAt: new Date(),
    providerObjectId: messageSid,
  });
  return result;
}

// ============================================================================
// outbound_call (operator-join-conference v1; aiMode deferred to Phase 7.5)
// ============================================================================

export interface OutboundCallPayload extends OutreachEvidenceFields {
  contactId: string;
  orgId: string;
  toNumber: string;
  aiMode?: boolean;
  aiInstructions?: string;
  templateName?: string;
  goalHint?: string;
  rationale: string;
}

export function parseOutboundCallPayload(
  proposedPayload: Record<string, unknown> | null | undefined,
): OutboundCallPayload | null {
  if (!proposedPayload || typeof proposedPayload !== 'object') return null;
  const contactId = proposedPayload['contactId'];
  const orgId = proposedPayload['orgId'];
  const toNumber = proposedPayload['toNumber'];
  const rationale = proposedPayload['rationale'];
  if (
    typeof contactId !== 'string' ||
    typeof orgId !== 'string' ||
    typeof toNumber !== 'string' ||
    typeof rationale !== 'string'
  ) {
    return null;
  }
  const out: OutboundCallPayload = { contactId, orgId, toNumber, rationale };
  if (typeof proposedPayload['aiMode'] === 'boolean') {
    out.aiMode = proposedPayload['aiMode'] as boolean;
  }
  if (typeof proposedPayload['aiInstructions'] === 'string') {
    out.aiInstructions = proposedPayload['aiInstructions'] as string;
  }
  if (typeof proposedPayload['templateName'] === 'string') {
    out.templateName = proposedPayload['templateName'] as string;
  }
  if (typeof proposedPayload['goalHint'] === 'string') {
    out.goalHint = proposedPayload['goalHint'] as string;
  }
  copyEvidenceFromPayload(proposedPayload, out);
  return out;
}

export async function applyOutboundCall(
  approvalId: string,
  payload: OutboundCallPayload,
): Promise<ExecutorResult> {
  if (await alreadyApplied(approvalId)) return { ok: true };
  if (!FROM_PHONE) {
    return { ok: false, error: 'TWILIO_PHONE_NUMBER not configured' };
  }
  // Phase 7.5: aiMode=true returns <Connect><Stream> pointing at
  // the voice-bridge Fly app. aiMode=false returns <Dial><Conference>
  // for operator-join. The TwiML route at /api/webhooks/twilio/twiml
  // serves the right verb based on `?mode=`.
  const twimlUrl = new URL(`${APP_URL}/api/webhooks/twilio/twiml`);
  twimlUrl.searchParams.set('approval', approvalId);
  twimlUrl.searchParams.set('mode', payload.aiMode ? 'ai' : 'conference');
  twimlUrl.searchParams.set('contactId', payload.contactId);
  twimlUrl.searchParams.set('orgId', payload.orgId);
  if (payload.aiInstructions) {
    twimlUrl.searchParams.set(
      'aiInstructions',
      payload.aiInstructions.slice(0, 4000),
    );
  }
  if (payload.goalHint) {
    twimlUrl.searchParams.set('goal', payload.goalHint.slice(0, 280));
  }
  // Status callbacks land on the same dispatcher endpoint as inbound
  // messages — the route discriminates by `?kind=status`. Earlier this
  // pointed at `/api/webhooks/twilio/status`, which doesn't exist;
  // every lifecycle event (ringing/answered/completed/CallDuration)
  // 404'd silently and never landed in events/touchpoints. Recording
  // callbacks have a separate `?kind=recording` path that the TwiML
  // route already configures correctly.
  const statusUrl = new URL(`${APP_URL}/api/webhooks/twilio`);
  statusUrl.searchParams.set('kind', 'status');
  statusUrl.searchParams.set('approval', approvalId);
  let callSid: string;
  try {
    const client = getTwilio();
    const call = await client.calls.create({
      from: FROM_PHONE,
      to: payload.toNumber,
      url: twimlUrl.toString(),
      statusCallback: statusUrl.toString(),
      statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
      record: true,
    });
    callSid = call.sid;
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
  const evidence = pickEvidence(payload);
  const evidenceMeta = buildOutreachMetadata(evidence);
  await writeOutboundTouchpoint(
    approvalId,
    'voice.initiated',
    payload.contactId,
    {
      provider_call_id: callSid,
      to_number: payload.toNumber,
      mode: payload.aiMode ? 'ai' : 'conference',
      template_name: payload.templateName ?? null,
      goal_hint: payload.goalHint ?? null,
      ...evidenceMeta,
    },
  );
  await costLedger.record({
    idempotencyKey: `outbound_call:${approvalId}`,
    operation: 'pstn.call',
    provider: 'twilio',
    units: 1,
    unitKind: 'calls',
    // Per-call setup cost; per-minute is recorded by the status callback
    // when CallDuration arrives.
    costUsdMicros: 0,
    occurredAt: new Date(),
  });
  const result = await stampApplied(approvalId, callSid, 'voice.initiated', {
    to: payload.toNumber,
    ...evidenceMeta,
  });
  await emitOutreachSent({
    approvalId,
    channel: 'outbound_call',
    evidence,
    occurredAt: new Date(),
    providerObjectId: callSid,
  });
  return result;
}

// ============================================================================
// shared helpers
// ============================================================================

async function writeOutboundTouchpoint(
  approvalId: string,
  channel: string,
  contactId: string | undefined,
  metadata: Record<string, unknown>,
): Promise<void> {
  const link = await resolveContactOrg(contactId);
  // If contactId provided but org didn't resolve, fall back to org_id
  // pulled from approval payload (caller's responsibility).
  let orgId = link?.orgId ?? null;
  if (!orgId && metadata['org_id'] && typeof metadata['org_id'] === 'string') {
    const orgRows = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.id, metadata['org_id'] as string))
      .limit(1);
    orgId = orgRows[0]?.id ?? null;
  }
  await db.insert(touchpoints).values({
    id: createId(),
    channel,
    actor: `approval:${approvalId}`,
    occurredAt: new Date(),
    contactId: link?.contactId ?? contactId ?? null,
    orgId,
    metadata,
  });
}

async function stampApplied(
  approvalId: string,
  appliedObjectId: string,
  verb: string,
  metadata: Record<string, unknown> = {},
): Promise<ExecutorResult> {
  const occurredAt = new Date();
  await db
    .update(approvals)
    .set({ appliedObjectId, appliedAt: occurredAt })
    .where(eq(approvals.id, approvalId));
  await db
    .insert(events)
    .values({
      id: createId(),
      verb,
      subjectType: 'approval',
      subjectId: approvalId,
      actorType: 'system',
      actorId: 'twilio-executor',
      objectType: verb.split('.')[0] ?? 'object',
      objectId: appliedObjectId,
      occurredAt,
      idempotencyKey: `${verb}:${approvalId}`,
      metadata,
    })
    .onConflictDoNothing({
      target: [events.occurredAt, events.idempotencyKey],
    });
  return { ok: true, appliedObjectId };
}
