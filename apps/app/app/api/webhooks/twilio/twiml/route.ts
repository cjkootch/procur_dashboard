import twilio from 'twilio';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * TwiML response endpoint Twilio fetches when an outbound call is
 * answered. Two modes per the `mode` query param:
 *
 *   conference — operator-join. Twilio dials the recipient, plays a
 *     brief intro, then puts them in a conference room keyed on the
 *     approval id. The operator joins via /voice when ready.
 *   ai — Phase 7.5 voice-bridge. <Connect><Stream> shuttles audio
 *     to procur-voice-bridge.fly.dev which proxies to OpenAI
 *     Realtime for full AI talkback.
 *
 * Query params:
 *   approval — approval id this call is the side-effect of
 *   mode     — 'conference' (v1) | 'ai' (Phase 7.5)
 *   contactId / orgId — touchpoint linkage
 *   goal     — operator-friendly one-liner shown on the call card
 *   aiInstructions — system-prompt text for the AI mode
 *
 * Auth: every request is signature-verified against TWILIO_AUTH_TOKEN
 * via Twilio's HMAC-SHA1 spec — same path the main /api/webhooks/twilio
 * dispatcher uses. Without it, anyone with a guessed approval id could
 * fetch this route and read the AI instructions / goal hint we attached
 * to the call (Finding #10 from the Phase 7 audit). ULIDs are
 * unguessable in practice but the fix is cheap so verify.
 *
 * Twilio almost always POSTs for TwiML fetches; the GET handler exists
 * for the Twilio Console's "Test" tool and TwiML Apps. Both are verified
 * identically — for GET the signature is over the URL with no body
 * params; for POST it's URL + sorted form-encoded params.
 */

async function verifyTwilioSignature(
  req: Request,
  params: Record<string, string>,
): Promise<boolean> {
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!authToken) return false;
  const signature = req.headers.get('x-twilio-signature');
  if (!signature) return false;
  return twilio.validateRequest(authToken, signature, req.url, params);
}

async function handleTwiml(req: Request): Promise<Response> {
  // Read the body once (POST only) — the signature is computed over
  // the form-encoded params, and we'd need to parse it anyway to use
  // any of the call context Twilio sends.
  let bodyParams: Record<string, string> = {};
  if (req.method === 'POST') {
    const rawBody = await req.text();
    try {
      bodyParams = Object.fromEntries(new URLSearchParams(rawBody)) as Record<
        string,
        string
      >;
    } catch {
      return new Response('invalid body', { status: 400 });
    }
  }

  const signatureValid = await verifyTwilioSignature(req, bodyParams);
  if (!signatureValid) {
    return new Response('invalid signature', { status: 401 });
  }

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
    // approval id. The operator joins via the /voice UI when ready.
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
