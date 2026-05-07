'use server';

import twilio from 'twilio';
import { eq } from 'drizzle-orm';
import { approvals, db } from '@procur/db';
import { requireCompany } from '@procur/auth';
import type { JoinConferenceState } from './state';

const E164 = /^\+[1-9]\d{7,14}$/;

/**
 * Operator-join. Dials the operator's mobile/desk phone and drops
 * them into the same Twilio conference the recipient is in. Avoids
 * needing a browser WebRTC client (Twilio Voice JS SDK + TwiML App
 * SID + microphone permissions) — works today with just a phone
 * number and the existing TWILIO_PHONE_NUMBER caller-id.
 *
 * The conference room is keyed `procur-${approvalId}` (matches what
 * apps/app/app/api/webhooks/twilio/twiml/route.ts wires for the
 * recipient). Inline TwiML on the calls.create() request joins the
 * operator into that room with `endConferenceOnExit=false` so hanging
 * up doesn't terminate the recipient's leg.
 */
export async function joinConferenceAction(
  _prev: JoinConferenceState,
  formData: FormData,
): Promise<JoinConferenceState> {
  await requireCompany();

  const approvalId = (formData.get('approvalId')?.toString() ?? '').trim();
  const operatorNumber = (formData.get('operatorNumber')?.toString() ?? '')
    .trim();

  if (!approvalId) {
    return { status: 'error', message: 'Missing approval id.' };
  }
  if (!E164.test(operatorNumber)) {
    return {
      status: 'error',
      message:
        'Phone number must be E.164 format (e.g. +18324927169 — country code, no spaces or dashes).',
    };
  }

  // Verify the approval is real, applied (i.e. there's an active call),
  // and is an outbound_call. Without these checks anyone with an
  // approvalId could trigger an outbound dial to any number.
  const approvalRows = await db
    .select({
      actionType: approvals.actionType,
      decision: approvals.decision,
      appliedAt: approvals.appliedAt,
      payload: approvals.proposedPayload,
    })
    .from(approvals)
    .where(eq(approvals.id, approvalId))
    .limit(1);
  const approval = approvalRows[0];
  if (!approval) {
    return { status: 'error', message: `Approval ${approvalId} not found.` };
  }
  if (approval.actionType !== 'outbound_call') {
    return {
      status: 'error',
      message: `Approval ${approvalId} is ${approval.actionType}, not an outbound_call.`,
    };
  }
  if (approval.decision !== 'approved' && approval.decision !== 'auto_approved') {
    return {
      status: 'error',
      message: 'Approval is not approved yet — wait for the operator decision.',
    };
  }
  if (!approval.appliedAt) {
    return {
      status: 'error',
      message:
        'Call has not been initiated yet — Twilio dispatch may have failed; check the executor logs.',
    };
  }
  const payload = (approval.payload as Record<string, unknown> | null) ?? {};
  if (payload['aiMode'] === true) {
    return {
      status: 'error',
      message:
        'Cannot join an AI-mode call — AI calls connect directly to the voice-bridge, not a conference room.',
    };
  }

  const fromNumber = process.env.TWILIO_PHONE_NUMBER;
  if (!fromNumber) {
    return {
      status: 'error',
      message: 'TWILIO_PHONE_NUMBER not configured on the server.',
    };
  }
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  if (!accountSid) {
    return {
      status: 'error',
      message: 'TWILIO_ACCOUNT_SID not configured on the server.',
    };
  }

  let client: ReturnType<typeof twilio>;
  const apiKey = process.env.TWILIO_API_KEY;
  const apiSecret = process.env.TWILIO_API_SECRET;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (apiKey && apiSecret) {
    client = twilio(apiKey, apiSecret, { accountSid });
  } else if (authToken) {
    client = twilio(accountSid, authToken);
  } else {
    return {
      status: 'error',
      message:
        'Twilio auth not configured: set TWILIO_API_KEY + TWILIO_API_SECRET or TWILIO_AUTH_TOKEN.',
    };
  }

  // Inline TwiML: dial the operator and on answer drop into the
  // conference. endConferenceOnExit=false so the operator hanging up
  // doesn't terminate the recipient's leg (recipient leg has
  // endConferenceOnExit=true; whoever's left can stay).
  const conferenceRoom = `procur-${approvalId}`;
  const twiml = new twilio.twiml.VoiceResponse();
  const dial = twiml.dial();
  dial.conference(
    {
      startConferenceOnEnter: true,
      endConferenceOnExit: false,
    },
    conferenceRoom,
  );

  let callSid: string;
  try {
    const call = await client.calls.create({
      from: fromNumber,
      to: operatorNumber,
      twiml: twiml.toString(),
    });
    callSid = call.sid;
  } catch (err) {
    return {
      status: 'error',
      message: `Twilio rejected the operator dial: ${(err as Error).message}`,
    };
  }

  return {
    status: 'success',
    callSid,
    message: `Calling ${operatorNumber} — answer to join ${conferenceRoom}.`,
  };
}
