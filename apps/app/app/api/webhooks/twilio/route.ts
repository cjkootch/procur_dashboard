import { and, desc, eq, like, sql } from 'drizzle-orm';
import twilio from 'twilio';
import {
  contacts,
  db,
  events,
  rawEvents,
  touchpoints,
} from '@procur/db';
import { createId, emitOutreachOutcome } from '@procur/ai';
import { recordWebhookReceipt } from '../../../../lib/webhook-events';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Twilio webhook handler per docs/vex-into-procur-merge-brief.md
 * Phase 7. Single endpoint that dispatches by query param `kind`:
 *
 *   ?kind=status      — call status callbacks (CallSid + CallStatus)
 *   ?kind=recording   — recording-status callbacks
 *   ?kind=inbound-sms — inbound SMS / WhatsApp messages
 *
 * The TwiML response endpoint lives at /api/webhooks/twilio/twiml
 * (separate route — needs to return XML, not JSON).
 *
 * All requests are signature-verified against TWILIO_AUTH_TOKEN
 * using Twilio's HMAC-SHA1 spec.
 */

async function verifyTwilioSignature(
  req: Request,
  rawBody: string,
): Promise<boolean> {
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!authToken) return false;
  const signature = req.headers.get('x-twilio-signature');
  if (!signature) return false;
  // Twilio's signature is computed over the request URL + form-encoded
  // params (sorted, concatenated). The SDK validates it given the URL
  // string + a flat params object reconstructed from the body.
  const url = req.url;
  let params: Record<string, string>;
  try {
    params = Object.fromEntries(new URLSearchParams(rawBody)) as Record<
      string,
      string
    >;
  } catch {
    return false;
  }
  return twilio.validateRequest(authToken, signature, url, params);
}

export async function POST(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const kind = url.searchParams.get('kind') ?? 'unknown';
  const rawBody = await req.text();

  const signatureValid = await verifyTwilioSignature(req, rawBody);
  if (!signatureValid) {
    await recordWebhookReceipt({
      provider: 'other',
      eventId: null,
      eventType: `twilio:${kind}`,
      responseStatus: 401,
      signatureValid: false,
      errorMessage: 'invalid Twilio signature',
    });
    return new Response('invalid signature', { status: 401 });
  }

  const params = Object.fromEntries(new URLSearchParams(rawBody)) as Record<
    string,
    string
  >;

  // Always record raw payload for audit, regardless of kind.
  const occurredAt = new Date();
  const providerEventId =
    params['MessageSid'] ?? params['CallSid'] ?? `twilio:${kind}:${createId()}`;
  await db
    .insert(rawEvents)
    .values({
      id: createId(),
      provider: 'twilio',
      providerEventId,
      headers: {},
      payload: { kind, params },
      receivedAt: occurredAt,
      status: 'pending',
    })
    .onConflictDoNothing({
      target: [
        rawEvents.receivedAt,
        rawEvents.provider,
        rawEvents.providerEventId,
      ],
    });

  if (kind === 'status') {
    await handleCallStatus(params);
  } else if (kind === 'recording') {
    await handleRecording(params);
  } else if (kind === 'inbound-sms' || kind === 'inbound-whatsapp') {
    await handleInboundMessage(params, kind);
  }

  await db
    .update(rawEvents)
    .set({ status: 'processed' })
    .where(
      sql`${rawEvents.providerEventId} = ${providerEventId} AND ${rawEvents.provider} = 'twilio'`,
    );

  await recordWebhookReceipt({
    provider: 'other',
    eventId: providerEventId,
    eventType: `twilio:${kind}`,
    responseStatus: 200,
    signatureValid: true,
    processed: true,
    payload: { kind, params },
  });
  return new Response('ok', { status: 200 });
}

async function handleCallStatus(
  params: Record<string, string>,
): Promise<void> {
  const callSid = params['CallSid'];
  const status = params['CallStatus'];
  const duration = params['CallDuration'] ? Number(params['CallDuration']) : null;
  if (!callSid || !status) return;
  await db
    .insert(events)
    .values({
      id: createId(),
      verb: `voice.${status}`,
      subjectType: 'call',
      subjectId: callSid,
      actorType: 'system',
      actorId: 'twilio',
      objectType: 'call',
      objectId: callSid,
      occurredAt: new Date(),
      idempotencyKey: `voice.${status}:${callSid}`,
      metadata: {
        duration_seconds: duration,
        from: params['From'] ?? null,
        to: params['To'] ?? null,
      },
    })
    .onConflictDoNothing({
      target: [events.occurredAt, events.idempotencyKey],
    });
  // Touchpoint on terminal statuses only.
  if (
    status === 'completed' ||
    status === 'failed' ||
    status === 'busy' ||
    status === 'no-answer'
  ) {
    await db.insert(touchpoints).values({
      id: createId(),
      channel: `voice.${status}`,
      actor: 'twilio',
      occurredAt: new Date(),
      contactId: null,
      orgId: null,
      metadata: {
        provider_call_id: callSid,
        duration_seconds: duration,
        from: params['From'] ?? null,
        to: params['To'] ?? null,
      },
    });
  }
}

async function handleRecording(
  params: Record<string, string>,
): Promise<void> {
  const callSid = params['CallSid'];
  const recordingSid = params['RecordingSid'];
  const recordingUrl = params['RecordingUrl'];
  if (!callSid || !recordingSid) return;
  await db
    .insert(events)
    .values({
      id: createId(),
      verb: 'voice.recorded',
      subjectType: 'call',
      subjectId: callSid,
      actorType: 'system',
      actorId: 'twilio',
      objectType: 'recording',
      objectId: recordingSid,
      occurredAt: new Date(),
      idempotencyKey: `voice.recorded:${recordingSid}`,
      metadata: {
        recording_url: recordingUrl ?? null,
        duration_seconds: params['RecordingDuration']
          ? Number(params['RecordingDuration'])
          : null,
      },
    })
    .onConflictDoNothing({
      target: [events.occurredAt, events.idempotencyKey],
    });
}

async function handleInboundMessage(
  params: Record<string, string>,
  kind: string,
): Promise<void> {
  const messageSid = params['MessageSid'];
  if (!messageSid) return;
  const fromRaw = params['From'] ?? '';
  const toRaw = params['To'] ?? '';
  const body = params['Body'] ?? '';
  const isWhatsapp = kind === 'inbound-whatsapp' || fromRaw.startsWith('whatsapp:');
  const channel = isWhatsapp ? 'whatsapp.received' : 'sms.received';
  // Strip 'whatsapp:' prefix if present, then normalize to E.164.
  const fromPhone = fromRaw.replace(/^whatsapp:/, '');

  // Best-effort contact match by phone number.
  let contactId: string | null = null;
  let orgId: string | null = null;
  if (fromPhone) {
    const contactRow = await db
      .select({ id: contacts.id, orgId: contacts.orgId })
      .from(contacts)
      .where(sql`${contacts.phones} @> ${JSON.stringify([fromPhone])}::jsonb`)
      .limit(1);
    if (contactRow[0]) {
      contactId = contactRow[0].id;
      orgId = contactRow[0].orgId;
    }
  }

  await db.insert(touchpoints).values({
    id: createId(),
    channel,
    actor: fromPhone || 'unknown',
    occurredAt: new Date(),
    contactId,
    orgId,
    metadata: {
      provider_message_id: messageSid,
      from: fromPhone,
      to: toRaw.replace(/^whatsapp:/, ''),
      body_text: body.slice(0, 4_000),
      contact_matched: Boolean(contactId),
    },
  });
  await db
    .insert(events)
    .values({
      id: createId(),
      verb: channel,
      subjectType: 'message',
      subjectId: messageSid,
      actorType: contactId ? 'contact' : 'unknown',
      actorId: contactId ?? fromPhone,
      objectType: 'channel',
      objectId: channel,
      occurredAt: new Date(),
      idempotencyKey: `${channel}:${messageSid}`,
      metadata: {
        from: fromPhone,
        body_preview: body.slice(0, 240),
      },
    })
    .onConflictDoNothing({
      target: [events.occurredAt, events.idempotencyKey],
    });

  // Outreach lifecycle: when an inbound SMS/WhatsApp arrives from a
  // number we recently sent to via the recommendation pipeline, emit
  // `outreach.replied` against the originating approval. Match by:
  //   - touchpoints.channel = sms.sent / whatsapp.sent
  //   - touchpoints.metadata->>'to' = fromPhone
  //   - touchpoints.actor LIKE 'approval:%' (extract the approval id)
  // 7-day lookback — replies after that are usually a fresh
  // conversation, not a reply to our outreach.
  if (fromPhone) {
    const outboundChannel = isWhatsapp ? 'whatsapp.sent' : 'sms.sent';
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000);
    const recentOutbound = await db
      .select({
        actor: touchpoints.actor,
        occurredAt: touchpoints.occurredAt,
      })
      .from(touchpoints)
      .where(
        and(
          eq(touchpoints.channel, outboundChannel),
          like(touchpoints.actor, 'approval:%'),
          sql`${touchpoints.metadata}->>'to' = ${fromPhone}`,
          sql`${touchpoints.occurredAt} >= ${sevenDaysAgo}`,
        ),
      )
      .orderBy(desc(touchpoints.occurredAt))
      .limit(1);
    const match = recentOutbound[0];
    if (match?.actor) {
      const approvalId = match.actor.slice('approval:'.length);
      await emitOutreachOutcome({
        approvalId,
        verb: 'outreach.replied',
        occurredAt: new Date(),
        objectId: messageSid,
        objectType: 'message',
        metadata: {
          channel: isWhatsapp ? 'whatsapp' : 'sms',
          inbound_message_sid: messageSid,
          from_phone: fromPhone,
        },
      });
    }
  }
}

// Twilio's GET preflight on the URL — return a 200 so a basic health
// check from the Twilio console doesn't show a red X.
export async function GET(): Promise<Response> {
  return new Response('twilio webhook ready', {
    status: 200,
    headers: { 'Content-Type': 'text/plain' },
  });
}
