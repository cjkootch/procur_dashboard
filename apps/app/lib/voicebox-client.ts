/**
 * Browser-side client for the operator's local Voicebox instance.
 *
 * Voicebox (https://github.com/jamiepine/voicebox) runs as a
 * localhost FastAPI server on the operator's machine — by default
 * at http://127.0.0.1:17493. Procur's dashboard, loaded in the
 * operator's browser ON THE SAME MACHINE, can reach Voicebox
 * directly via fetch. No tunnel, no API keys, no rate limits.
 *
 * The procur backend (Vercel) cannot reach localhost:17493 — that's
 * why this client lives in the BROWSER and only the resulting
 * audio bytes get uploaded to procur's server.
 *
 * Known constraints (operator setup):
 *   - CORS: Voicebox must allow cross-origin requests from procur's
 *     origin (app.procur.app in production; localhost:3000 in dev).
 *     If your Voicebox build rejects the preflight, audio
 *     generation from the dashboard fails — `detectVoicebox()`
 *     returns ok:false and the UI falls back to manual upload.
 *   - Mixed content: browsers block HTTP fetches from HTTPS pages
 *     in some configurations. localhost is whitelisted in modern
 *     Chrome/Safari/Firefox, but corporate-managed browsers can
 *     override. Same fallback applies.
 *
 * Both constraints are operator-side fixes; procur's code can't
 * work around them. We detect-and-degrade gracefully rather than
 * trying.
 */

const VOICEBOX_BASE = 'http://127.0.0.1:17493';
const HEALTH_TIMEOUT_MS = 2_000;

/** ISO 639-1 codes Voicebox actually exposes in its UI (mirrors the
 *  language picker in Voicebox's web app). The HTTP API may accept
 *  more, but model quality is only guaranteed for these. Keep this
 *  list tight — surfacing an unsupported language to the operator
 *  results in noticeably degraded synthesis. */
export const VOICEBOX_SUPPORTED_LANGUAGES = [
  'zh',
  'en',
  'ja',
  'ko',
  'de',
  'fr',
  'ru',
  'pt',
  'es',
  'it',
] as const;

export type VoiceboxLanguage = (typeof VOICEBOX_SUPPORTED_LANGUAGES)[number];

export function isVoiceboxSupportedLanguage(
  code: string,
): code is VoiceboxLanguage {
  return (VOICEBOX_SUPPORTED_LANGUAGES as readonly string[]).includes(code);
}

/** Mirrors Voicebox's VoiceProfileResponse (per OpenAPI spec at
 *  http://127.0.0.1:17493/docs). We only consume a subset; everything
 *  else gets ignored. */
export interface VoiceboxProfile {
  id: string;
  name: string;
  /** Voicebox uses `default_engine`; we surface it as `engine` on
   *  this consumer-side type for brevity. The UI doesn't need to
   *  distinguish the field name from Voicebox's wire shape. */
  engine?: string;
  language?: string;
  /** 'cloned' | 'preset' | 'designed' per the spec. Mostly cosmetic
   *  for our UI; we'll surface it in the profile dropdown when
   *  multiple profiles share a name. */
  voiceType?: string;
}

export interface VoiceboxEngine {
  id: string;
  name?: string;
}

export interface VoiceboxHealth {
  ok: boolean;
  version?: string;
  reason?: string;
}

/**
 * Quick health probe. Times out fast so the dashboard doesn't hang
 * for users who don't run Voicebox. Returns ok:false on any error
 * — the panel just falls back to manual-upload mode silently.
 */
export async function detectVoicebox(): Promise<VoiceboxHealth> {
  try {
    const res = await fetch(`${VOICEBOX_BASE}/health`, {
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    if (!res.ok) return { ok: false, reason: `health ${res.status}` };
    const data = (await res.json().catch(() => ({}))) as {
      version?: string;
    };
    return { ok: true, version: data.version };
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : 'unknown',
    };
  }
}

/**
 * List the operator's voice profiles. Voicebox returns
 * VoiceProfileResponse[] per the OpenAPI spec — we map to our
 * narrower consumer-side shape.
 */
export async function listVoiceboxProfiles(): Promise<VoiceboxProfile[]> {
  const res = await fetch(`${VOICEBOX_BASE}/profiles`);
  if (!res.ok) throw new Error(`profiles ${res.status}`);
  const raw = (await res.json()) as Array<{
    id: string;
    name: string;
    default_engine?: string | null;
    language?: string;
    voice_type?: string;
  }>;
  if (!Array.isArray(raw)) return [];
  return raw.map((p) => ({
    id: p.id,
    name: p.name,
    ...(p.default_engine ? { engine: p.default_engine } : {}),
    ...(p.language ? { language: p.language } : {}),
    ...(p.voice_type ? { voiceType: p.voice_type } : {}),
  }));
}

export interface GenerateVoiceboxAudioInput {
  text: string;
  profileId: string;
  /** Engine to use — Voicebox supports multiple
   *  (qwen / qwen_custom_voice / luxtts / chatterbox /
   *  chatterbox_turbo / tada / kokoro per the OpenAPI spec). The
   *  profile may have a default engine; passing one here overrides. */
  engine?: string;
  /** ISO 639-1 lowercase. Voicebox's UI exposes 10 languages with
   *  guaranteed model quality — see VOICEBOX_SUPPORTED_LANGUAGES.
   *  The HTTP API may accept others; quality degrades and we don't
   *  advertise them in the dashboard's picker. */
  language?: string;
  /** Voicebox-specific delivery instruction string ("warm, slow,
   *  cinematic"). Engine-dependent — works with qwen-family engines. */
  instruct?: string;
}

export interface GeneratedAudio {
  blob: Blob;
  /** Duration of the audio in milliseconds. Best-effort: probed
   *  via a transient Audio element. Undefined when probing fails
   *  (e.g. unsupported codec, or the operator's browser doesn't
   *  decode the format Voicebox returned). */
  durationMs?: number;
  /** MIME type as reported by Voicebox response Content-Type. */
  contentType: string;
}

/**
 * Generate audio via Voicebox. Uses `POST /generate/stream` — a
 * synchronous endpoint that streams WAV bytes directly without
 * persisting to Voicebox's local generation history. We don't
 * want server-side history clutter from probe-tier generations
 * anyway; the operator's interest in version-control of recordings
 * lives on procur's side via `rvm_audio_assets.is_active` history.
 *
 * The earlier shape used `POST /generate` which is ASYNC: returns
 * GenerationResponse JSON with status='generating' + an id, then
 * the caller polls `/generate/{id}/status` (SSE) until completed
 * and fetches via `/audio/{id}`. Three round trips. /generate/stream
 * collapses that to one — perfect for our "browser → bytes →
 * upload to procur" flow.
 *
 * Returns the raw bytes as a Blob (no auto-upload — caller decides
 * whether to forward to procur's /api/rvm/audio-assets endpoint).
 * Caller is responsible for managing the blob URL lifecycle (call
 * URL.revokeObjectURL when done previewing).
 */
export async function generateVoiceboxAudio(
  input: GenerateVoiceboxAudioInput,
): Promise<GeneratedAudio> {
  const res = await fetch(`${VOICEBOX_BASE}/generate/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text: input.text,
      profile_id: input.profileId,
      ...(input.engine ? { engine: input.engine } : {}),
      ...(input.language ? { language: input.language } : {}),
      ...(input.instruct ? { instruct: input.instruct } : {}),
    }),
  });
  if (!res.ok) {
    const bodyText = await res.text().catch(() => '');
    throw new Error(`generate ${res.status}: ${bodyText.slice(0, 200)}`);
  }
  // /generate/stream returns audio/wav per the spec.
  const contentType = res.headers.get('content-type') ?? 'audio/wav';
  const blob = await res.blob();
  const durationMs = await probeDurationMs(blob);
  return { blob, durationMs, contentType };
}

/**
 * Best-effort duration probe via a transient Audio element. Returns
 * undefined on any error rather than failing the upload — duration
 * is metadata that helps the autopilot enforce voicemail-box length
 * limits, but isn't required.
 */
async function probeDurationMs(blob: Blob): Promise<number | undefined> {
  try {
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    try {
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          audio.removeEventListener('loadedmetadata', onLoad);
          audio.removeEventListener('error', onError);
        };
        const onLoad = () => {
          cleanup();
          resolve();
        };
        const onError = () => {
          cleanup();
          reject(new Error('audio load failed'));
        };
        audio.addEventListener('loadedmetadata', onLoad);
        audio.addEventListener('error', onError);
      });
      if (
        Number.isFinite(audio.duration) &&
        audio.duration > 0 &&
        audio.duration < 600
      ) {
        return Math.round(audio.duration * 1000);
      }
      return undefined;
    } finally {
      URL.revokeObjectURL(url);
    }
  } catch {
    return undefined;
  }
}
