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

export interface VoiceboxProfile {
  id: string;
  name: string;
  engine?: string;
  language?: string;
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
 * List the operator's voice profiles. The Voicebox /profiles
 * endpoint may return either a bare array OR `{ profiles: [...] }`
 * depending on the build — we accept both shapes.
 */
export async function listVoiceboxProfiles(): Promise<VoiceboxProfile[]> {
  const res = await fetch(`${VOICEBOX_BASE}/profiles`);
  if (!res.ok) throw new Error(`profiles ${res.status}`);
  const data = (await res.json()) as
    | VoiceboxProfile[]
    | { profiles?: VoiceboxProfile[] };
  if (Array.isArray(data)) return data;
  return data.profiles ?? [];
}

export interface GenerateVoiceboxAudioInput {
  text: string;
  profileId: string;
  /** Engine to use — Voicebox supports multiple (qwen_custom_voice,
   *  chatterbox, kokoro, etc.). The profile may have a default
   *  engine; passing one here overrides. */
  engine?: string;
  /** Voicebox-specific delivery instruction string ("warm, slow,
   *  cinematic"). Engine-dependent. */
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
 * Generate audio via Voicebox. Returns the raw bytes as a Blob
 * (no auto-upload — caller decides whether to forward to procur's
 * /api/rvm/audio-assets endpoint). Caller is responsible for
 * managing the blob URL lifecycle (call URL.revokeObjectURL when
 * done previewing).
 */
export async function generateVoiceboxAudio(
  input: GenerateVoiceboxAudioInput,
): Promise<GeneratedAudio> {
  const res = await fetch(`${VOICEBOX_BASE}/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text: input.text,
      profile_id: input.profileId,
      ...(input.engine ? { engine: input.engine } : {}),
      ...(input.instruct ? { instruct: input.instruct } : {}),
    }),
  });
  if (!res.ok) {
    const bodyText = await res.text().catch(() => '');
    throw new Error(`generate ${res.status}: ${bodyText.slice(0, 200)}`);
  }
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
