import twilio from 'twilio';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * TwiML response endpoint Twilio fetches when an outbound call is
 * answered. Phase 7 v1 supports `mode=conference` only (operator
 * dials in to the conference; AI talkback ships in Phase 7.5 once
 * the voice-bridge Fly app is up).
 *
 * Query params:
 *   approval — approval id this call is the side-effect of
 *   mode     — 'conference' (v1) | 'ai' (rejected; phase 7.5)
 *   contactId / orgId — touchpoint linkage
 *   goal     — operator-friendly one-liner shown on the call card
 *
 * Auth: Twilio fetches the URL with no signed body. The URL is
 * generated server-side by the executor and includes the approval
 * id, which is unguessable. Future hardening: HMAC-sign the URL
 * ourselves OR validate X-Twilio-Signature.
 *
 * Both GET and POST are accepted — Twilio defaults to POST for
 * TwiML fetches, but Voice TwiML Apps (browser-client calls) and
 * the Twilio Console's "Test" tool may use GET.
 */
async function handleTwiml(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const mode = url.searchParams.get('mode') ?? 'conference';
  const approvalId = url.searchParams.get('approval') ?? 'unknown';

  const twiml = new twilio.twiml.VoiceResponse();

  if (mode === 'ai') {
    // AI talkback path — Phase 7.5 voice-bridge running on Fly.
    // The bridge accepts a WebSocket at /twilio-stream and shuttles
    // audio to OpenAI Realtime. Per-call instructions ride on
    // <Parameter> children (Twilio strips query strings from the
    // <Stream url=> attribute).
    const bridgeUrl =
      process.env.VOICE_BRIDGE_WSS_URL ??
      'wss://procur-voice-bridge.fly.dev/twilio-stream';
    const aiInstructions = url.searchParams.get('aiInstructions');
    const goalHint = url.searchParams.get('goal');
    const connect = twiml.connect();
    const stream = connect.stream({ url: bridgeUrl });
    stream.parameter({ name: 'approvalId', value: approvalId });
    if (aiInstructions) {
      stream.parameter({ name: 'aiInstructions', value: aiInstructions });
    }
    if (goalHint) {
      stream.parameter({ name: 'goalHint', value: goalHint });
    }
  } else {
    // Operator-join-conference. Twilio dials the recipient, plays a
    // brief intro, then puts them in a conference room keyed on the
    // approval id. The operator joins via the calls UI when ready.
    twiml.say(
      { voice: 'Polly.Joanna' },
      'Please hold while we connect you to a team member.',
    );
    const dial = twiml.dial();
    dial.conference(
      {
        startConferenceOnEnter: true,
        endConferenceOnExit: true,
        statusCallback: `${url.origin}/api/webhooks/twilio?kind=status&approval=${encodeURIComponent(approvalId)}`,
      },
      `procur-${approvalId}`,
    );
  }

  return new Response(twiml.toString(), {
    status: 200,
    headers: { 'Content-Type': 'text/xml' },
  });
}

export const GET = handleTwiml;
export const POST = handleTwiml;
