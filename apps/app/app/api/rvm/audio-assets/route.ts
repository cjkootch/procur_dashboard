import { NextResponse } from 'next/server';
import { put } from '@vercel/blob';
import { z } from 'zod';
import { requireCompany } from '@procur/auth';
import { createRvmAudioAsset, getProbe } from '@procur/catalog';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/rvm/audio-assets
 *
 * Operator-driven audio upload for RVM dispatch. Two flows feed
 * this same endpoint:
 *   - Manual upload: drag-drop a .mp3/.wav generated externally
 *     (ElevenLabs UI, hand recording, Slybroadcast asset library)
 *   - Voicebox-generated: browser POSTs to localhost:17493/generate,
 *     gets audio bytes back, forwards them here (PR 2)
 *
 * Request shape (multipart/form-data):
 *   file:           audio/mpeg or audio/wav (required)
 *   probeId:        market_probes.id (required)
 *   variantId:      market_probe_message_variants.id (optional —
 *                   omit for probe-default audio)
 *   language:       ISO 639-1 lowercase (required)
 *   sourceText:     plain-text transcript of what the audio says
 *                   (required; audit + retranslation)
 *   voiceProfileId: Voicebox profile id when generated via Voicebox
 *   generatedVia:   'voicebox' | 'manual_upload' | 'elevenlabs'
 *                   | 'other' (required)
 *   durationMs:     integer; optional (browser can probe via Audio
 *                   element)
 *
 * Discipline:
 *   - Audio uploaded with public-read ACL because Twilio's TwiML
 *     <Play> verb fetches the URL anonymously. Operator-private
 *     audio is NOT a goal — once dispatched, the recipient's phone
 *     receives it. There's no privacy benefit to ACL-gating the
 *     blob.
 *   - 5 MB cap covers typical 60-90s voicemail at 128kbps mp3
 *     (~1 MB) with margin; rejects accidental video uploads.
 *   - Whitelist content types so a confused caller can't store an
 *     HTML-shaped blob and trick Twilio into rendering it.
 */

const MAX_AUDIO_BYTES = 5 * 1024 * 1024; // 5 MB
const ALLOWED_AUDIO_TYPES = new Set([
  'audio/mpeg',
  'audio/mp3',
  'audio/wav',
  'audio/wave',
  'audio/x-wav',
]);

const FormSchema = z.object({
  probeId: z.string().min(1).max(64),
  variantId: z.string().min(1).max(64).optional().nullable(),
  language: z
    .string()
    .regex(/^[a-z]{2}$/, 'expected 2-letter ISO 639-1 lowercase'),
  sourceText: z.string().min(1).max(4000),
  voiceProfileId: z.string().min(1).max(200).optional().nullable(),
  generatedVia: z.enum([
    'voicebox',
    'manual_upload',
    'elevenlabs',
    'other',
  ]),
  durationMs: z.number().int().positive().max(180_000).optional().nullable(),
});

export async function POST(req: Request): Promise<Response> {
  const { user, company } = await requireCompany();

  const form = await req.formData().catch(() => null);
  if (!form) {
    return NextResponse.json({ error: 'expected multipart/form-data' }, { status: 400 });
  }

  const file = form.get('file');
  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'file required' }, { status: 400 });
  }
  if (file.size > MAX_AUDIO_BYTES) {
    return NextResponse.json(
      { error: 'file_too_large', maxBytes: MAX_AUDIO_BYTES },
      { status: 413 },
    );
  }
  const contentType = (file.type || '').toLowerCase();
  if (!ALLOWED_AUDIO_TYPES.has(contentType)) {
    return NextResponse.json(
      {
        error: 'unsupported_content_type',
        got: contentType || '(empty)',
        allowed: [...ALLOWED_AUDIO_TYPES],
      },
      { status: 415 },
    );
  }

  // The non-file fields ride alongside as form-data values.
  const fields: Record<string, unknown> = {
    probeId: form.get('probeId')?.toString() ?? '',
    language: form.get('language')?.toString().toLowerCase() ?? '',
    sourceText: form.get('sourceText')?.toString() ?? '',
    generatedVia: form.get('generatedVia')?.toString() ?? '',
  };
  const variantIdRaw = form.get('variantId')?.toString();
  if (variantIdRaw && variantIdRaw.length > 0) fields['variantId'] = variantIdRaw;
  const voiceProfileIdRaw = form.get('voiceProfileId')?.toString();
  if (voiceProfileIdRaw && voiceProfileIdRaw.length > 0) {
    fields['voiceProfileId'] = voiceProfileIdRaw;
  }
  const durationMsRaw = form.get('durationMs')?.toString();
  if (durationMsRaw && durationMsRaw.length > 0) {
    const n = Number.parseInt(durationMsRaw, 10);
    if (Number.isFinite(n) && n > 0) fields['durationMs'] = n;
  }

  const parsed = FormSchema.safeParse(fields);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid_input', details: parsed.error.issues },
      { status: 400 },
    );
  }

  // Probe must exist + belong to a probe the user's company can
  // see. probe ownership today is "single-tenant flat" — every
  // logged-in user can write to every probe — but we still check
  // existence so a stray probeId doesn't write a dangling row.
  const probe = await getProbe(parsed.data.probeId);
  if (!probe) {
    return NextResponse.json({ error: 'probe_not_found' }, { status: 404 });
  }

  // Upload to Vercel Blob. Path includes companyId + probeId so the
  // operator can scan their own assets via the blob console.
  const ext = contentType.includes('wav') ? 'wav' : 'mp3';
  const safeProbeId = parsed.data.probeId.replace(/[^a-zA-Z0-9_-]/g, '_');
  const blobPath = `rvm/${company.id}/${safeProbeId}/${parsed.data.language}-${Date.now()}.${ext}`;
  const blobBytes = Buffer.from(await file.arrayBuffer());
  const uploaded = await put(blobPath, blobBytes, {
    access: 'public',
    contentType,
  });

  const created = await createRvmAudioAsset({
    probeId: parsed.data.probeId,
    variantId: parsed.data.variantId ?? null,
    language: parsed.data.language,
    sourceText: parsed.data.sourceText,
    audioUrl: uploaded.url,
    audioFormat: contentType,
    durationMs: parsed.data.durationMs ?? null,
    voiceProfileId: parsed.data.voiceProfileId ?? null,
    generatedVia: parsed.data.generatedVia,
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
      durationMs: created.durationMs,
      generatedVia: created.generatedVia,
      generatedAt: created.generatedAt.toISOString(),
    },
  });
}
