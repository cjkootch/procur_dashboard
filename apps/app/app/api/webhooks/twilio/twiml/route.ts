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
 * Auth: Twilio fetches the URL with no signed body (it's a GET).
 * The URL is generated server-side by the executor and includes the
 * approval id, which is unguessable. Future hardening: HMAC-sign
 * the URL ourselves.
 */
export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const mode = url.searchParams.get('mode') ?? 'conference';
  const approvalId = url.searchParams.get('approval') ?? 'unknown';

  const twiml = new twilio.twiml.VoiceResponse();

  if (mode === 'ai') {
    // AI talkback path — needs the voice-bridge running on Fly.
    // Phase 7 ships rejection at the executor; this branch should
    // never be hit until Phase 7.5 lands. Return a "transient
    // failure" TwiML so the call hangs up cleanly.
    twiml.say(
      { voice: 'Polly.Joanna' },
      'AI assistant is not yet available. Disconnecting.',
    );
    twiml.hangup();
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
