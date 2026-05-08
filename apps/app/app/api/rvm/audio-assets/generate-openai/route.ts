import { NextResponse } from 'next/server';
import { put } from '@vercel/blob';
import { z } from 'zod';
import { requireCompany } from '@procur/auth';
import { createRvmAudioAsset, getProbe } from '@procur/catalog';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/rvm/audio-assets/generate-openai
 *
 * Server-side TTS generation via OpenAI's Audio API. Lets the
 * operator render RVM audio in the SAME voice their live outbound
 * calls use (the voice-bridge service runs OpenAI Realtime with
 * voice='alloy' by default — pre-rendering RVM with the same voice
 * means recipients hear the same persona on the voicemail and on
 * any subsequent live call).
 *
 * Why server-side instead of browser:
 *   - The OpenAI API key is server-only (not safe to ship to the
 *     browser). Voicebox runs locally so the browser can call it
 *     directly; OpenAI does not.
 *   - Procur backend already has OPENAI_API_KEY for the voice-
 *     bridge service. Reusing it here keeps the credential
 *     management surface flat.
 *
 * Voice options (per OpenAI gpt-4o-mini-tts):
 *   alloy, ash, ballad, coral, echo, fable, onyx, nova, sage,
 *   shimmer, verse. Default: env OPENAI_TTS_VOICE or 'alloy' to
 *   match the voice-bridge default.
 *
 * Cost: ~$0.015 per 1K chars (gpt-4o-mini-tts). A 60-second
 * voicemail is ~140 words ≈ 800 chars ≈ $0.012 per asset. Cheap
 * enough that operator iteration is fine.
 *
 * Audio format: returns mp3 by default; Twilio TwiML <Play>
 * accepts mp3 + wav. We store mp3 to keep blob storage tight.
 */

const VOICE_ALLOWLIST = [
  'alloy',
  'ash',
  'ballad',
  'coral',
  'echo',
  'fable',
  'onyx',
  'nova',
  'sage',
  'shimmer',
  'verse',
] as const;

const RequestSchema = z.object({
  probeId: z.string().min(1).max(64),
  variantId: z.string().min(1).max(64).optional().nullable(),
  language: z
    .string()
    .regex(/^[a-z]{2}$/, 'expected 2-letter ISO 639-1 lowercase'),
  sourceText: z.string().min(1).max(4000),
  voice: z.enum(VOICE_ALLOWLIST).optional(),
  /** Optional model override. gpt-4o-mini-tts is cheaper; tts-1
   *  / tts-1-hd are higher quality. Default mini-tts to match
   *  the cost expectations of probe-tier RVM. */
  model: z.enum(['gpt-4o-mini-tts', 'tts-1', 'tts-1-hd']).optional(),
  /** Optional natural-language style instruction for gpt-4o-mini-tts.
   *  Ignored by tts-1 / tts-1-hd. */
  instructions: z.string().min(1).max(500).optional(),
});

export async function POST(req: Request): Promise<Response> {
  const { user, company } = await requireCompany();

  if (!process.env.OPENAI_API_KEY) {
    return NextResponse.json(
      { error: 'openai_not_configured', message: 'OPENAI_API_KEY not set' },
      { status: 503 },
    );
  }

  const body = (await req.json().catch(() => null)) as unknown;
  const parsed = RequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid_input', details: parsed.error.issues },
      { status: 400 },
    );
  }

  const probe = await getProbe(parsed.data.probeId);
  if (!probe) {
    return NextResponse.json({ error: 'probe_not_found' }, { status: 404 });
  }

  // Voice selection: explicit > env > 'alloy' (matches voice-bridge
  // default so RVM and live calls use the same persona).
  const voice =
    parsed.data.voice ??
    (VOICE_ALLOWLIST as readonly string[]).includes(
      process.env.OPENAI_TTS_VOICE ?? '',
    )
      ? ((parsed.data.voice ??
          process.env.OPENAI_TTS_VOICE ??
          'alloy') as (typeof VOICE_ALLOWLIST)[number])
      : 'alloy';
  const model = parsed.data.model ?? 'gpt-4o-mini-tts';

  // Call OpenAI TTS. Returns audio bytes directly.
  const ttsRes = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model,
      voice,
      input: parsed.data.sourceText,
      response_format: 'mp3',
      ...(parsed.data.instructions && model === 'gpt-4o-mini-tts'
        ? { instructions: parsed.data.instructions }
        : {}),
    }),
  });
  if (!ttsRes.ok) {
    const errText = await ttsRes.text().catch(() => '');
    return NextResponse.json(
      {
        error: 'openai_tts_failed',
        status: ttsRes.status,
        detail: errText.slice(0, 500),
      },
      { status: 502 },
    );
  }
  const audioBytes = Buffer.from(await ttsRes.arrayBuffer());
  if (audioBytes.byteLength === 0) {
    return NextResponse.json(
      { error: 'openai_returned_empty_audio' },
      { status: 502 },
    );
  }

  // Upload to Vercel Blob with public-read ACL.
  const safeProbeId = parsed.data.probeId.replace(/[^a-zA-Z0-9_-]/g, '_');
  const blobPath = `rvm/${company.id}/${safeProbeId}/${parsed.data.language}-openai-${Date.now()}.mp3`;
  const uploaded = await put(blobPath, audioBytes, {
    access: 'public',
    contentType: 'audio/mpeg',
  });

  const created = await createRvmAudioAsset({
    probeId: parsed.data.probeId,
    variantId: parsed.data.variantId ?? null,
    language: parsed.data.language,
    sourceText: parsed.data.sourceText,
    audioUrl: uploaded.url,
    audioFormat: 'audio/mpeg',
    durationMs: null, // server-side; could probe with ffprobe but skip
    voiceProfileId: voice, // record which OpenAI voice was used
    generatedVia: 'openai_tts',
    generatedByUserId: user.id,
  });

  return NextResponse.json({
    ok: true,
    asset: {
      id: created.id,
      probeId: created.probeId,
      variantId: created.variantId,
      language: created.language,
      audioUrl: created.audioUrl,
      audioFormat: created.audioFormat,
      voice,
      model,
      generatedAt: created.generatedAt.toISOString(),
    },
  });
}
