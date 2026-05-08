'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  detectVoicebox,
  generateVoiceboxAudio,
  listVoiceboxProfiles,
  type VoiceboxHealth,
  type VoiceboxProfile,
} from '../../../lib/voicebox-client';

const OPENAI_VOICES = [
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

/**
 * RVM audio asset panel on the probe page. PR 1 ships the upload-
 * only flow: operator drag-drops an .mp3 / .wav generated externally
 * (ElevenLabs UI, Voicebox export, hand recording, Slybroadcast
 * asset library). PR 2 will add browser-side Voicebox integration
 * that calls localhost:17493/generate from the browser and forwards
 * bytes to this same API endpoint.
 *
 * Visual model:
 *   - List of assets, grouped by language, with active/retired
 *     badges + audio preview
 *   - Upload form: file + language + sourceText + variant scope
 *     (probe-default OR specific variant) + generation source
 */

interface AudioAssetRow {
  id: string;
  probeId: string;
  variantId: string | null;
  language: string;
  sourceText: string;
  audioUrl: string;
  audioFormat: string;
  durationMs: number | null;
  voiceProfileId: string | null;
  generatedVia: string;
  generatedAt: Date;
  isActive: boolean;
}

interface VariantSummary {
  id: string;
  name: string;
}

export function RvmAudioPanel({
  probeId,
  probeOutreachLanguage,
  variants,
  assets,
}: {
  probeId: string;
  probeOutreachLanguage: string | null;
  variants: VariantSummary[];
  assets: AudioAssetRow[];
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Voicebox detection runs once on mount. Times out fast (2s) so
  // it doesn't slow page load for operators who don't run Voicebox.
  // Result is sticky for the page lifetime — operator who starts
  // Voicebox after the page loaded would need a refresh. Acceptable
  // friction; rare workflow.
  const [voiceboxHealth, setVoiceboxHealth] =
    useState<VoiceboxHealth | null>(null);
  const [voiceboxProfiles, setVoiceboxProfiles] =
    useState<VoiceboxProfile[]>([]);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const health = await detectVoicebox();
      if (cancelled) return;
      setVoiceboxHealth(health);
      if (health.ok) {
        try {
          const profiles = await listVoiceboxProfiles();
          if (!cancelled) setVoiceboxProfiles(profiles);
        } catch {
          /* graceful degrade — generation still possible if operator
             knows their profile id */
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Active tab in the upload section. Default to 'manual' so the
  // panel works for operators without OpenAI / Voicebox configured.
  const [genMode, setGenMode] = useState<
    'manual' | 'voicebox' | 'openai'
  >('manual');

  const activeAssets = assets.filter((a) => a.isActive);
  const retiredAssets = assets.filter((a) => !a.isActive);

  const handleUpload = async (formData: FormData) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/rvm/audio-assets', {
        method: 'POST',
        body: formData,
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        setError(body.error ?? `upload failed (${res.status})`);
        return;
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'unknown error');
    } finally {
      setBusy(false);
    }
  };

  /**
   * Voicebox flow: call localhost:17493/generate from the BROWSER,
   * receive audio bytes, forward them to procur's /api/rvm/audio-
   * assets endpoint as a multipart upload. Procur server uploads
   * to Vercel Blob + creates the asset row.
   *
   * Voicebox CORS must allow the procur origin. If preflight fails,
   * the fetch throws and we surface the error to the operator —
   * Voicebox config is operator-side.
   */
  const handleVoiceboxGenerate = async (input: {
    text: string;
    profileId: string;
    engine?: string;
    instruct?: string;
    language: string;
    variantId: string | null;
  }) => {
    setBusy(true);
    setError(null);
    try {
      const audio = await generateVoiceboxAudio({
        text: input.text,
        profileId: input.profileId,
        ...(input.engine ? { engine: input.engine } : {}),
        ...(input.instruct ? { instruct: input.instruct } : {}),
        // Voicebox /generate/stream supports a language param per
        // the OpenAPI spec — passing it lets the qwen3-tts engine
        // select the right phoneme model for non-English locales.
        language: input.language,
      });
      const fd = new FormData();
      const ext = audio.contentType.includes('wav') ? 'wav' : 'mp3';
      fd.append(
        'file',
        new File([audio.blob], `voicebox-${Date.now()}.${ext}`, {
          type: audio.contentType,
        }),
      );
      fd.append('probeId', probeId);
      if (input.variantId) fd.append('variantId', input.variantId);
      fd.append('language', input.language);
      fd.append('sourceText', input.text);
      fd.append('voiceProfileId', input.profileId);
      fd.append('generatedVia', 'voicebox');
      if (audio.durationMs) {
        fd.append('durationMs', String(audio.durationMs));
      }
      await handleUpload(fd);
    } catch (err) {
      setError(
        err instanceof Error
          ? `Voicebox generation failed: ${err.message}`
          : 'Voicebox generation failed',
      );
      setBusy(false);
    }
  };

  /**
   * OpenAI flow: server-side generation. Browser POSTs JSON to
   * /api/rvm/audio-assets/generate-openai; server calls OpenAI TTS
   * with the operator's API key (server-only credential), uploads
   * resulting audio to Blob, creates the row in one shot. No
   * separate file upload step.
   */
  const handleOpenAIGenerate = async (input: {
    text: string;
    voice: string;
    language: string;
    variantId: string | null;
    instructions?: string;
  }) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/rvm/audio-assets/generate-openai', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          probeId,
          variantId: input.variantId,
          language: input.language,
          sourceText: input.text,
          voice: input.voice,
          ...(input.instructions ? { instructions: input.instructions } : {}),
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
          detail?: string;
        };
        setError(
          body.error
            ? `${body.error}${body.detail ? ': ' + body.detail.slice(0, 200) : ''}`
            : `OpenAI generation failed (${res.status})`,
        );
        return;
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'unknown error');
    } finally {
      setBusy(false);
    }
  };

  const handleRetire = async (assetId: string) => {
    if (!confirm('Retire this audio asset? It can be reactivated later.')) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/rvm/audio-assets/${assetId}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        setError(`retire failed (${res.status})`);
        return;
      }
      router.refresh();
    } finally {
      setBusy(false);
    }
  };

  const handleReactivate = async (assetId: string) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/rvm/audio-assets/${assetId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'reactivate' }),
      });
      if (!res.ok) {
        setError(`reactivate failed (${res.status})`);
        return;
      }
      router.refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="mt-6 rounded-[var(--radius-lg)] border border-[color:var(--color-border)] p-5">
      <h2 className="mb-1 text-sm font-semibold uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
        RVM audio assets ({activeAssets.length} active)
      </h2>
      <p className="mb-4 text-xs text-[color:var(--color-muted-foreground)]">
        Pre-recorded audio Twilio plays into recipients&apos; voicemail
        boxes via MachineDetection. Per (probe, variant, language) —
        variant-specific wins over probe-default. Upload an .mp3 or
        .wav generated by Voicebox, ElevenLabs, or your preferred TTS.
      </p>

      {error && (
        <p className="mb-3 rounded-[var(--radius-md)] bg-red-50 px-3 py-1.5 text-xs text-red-900">
          {error}
        </p>
      )}

      {/* Active asset list */}
      {activeAssets.length > 0 && (
        <div className="mb-5 space-y-2">
          {activeAssets.map((a) => (
            <AudioAssetRowView
              key={a.id}
              asset={a}
              variants={variants}
              onAction={() => void handleRetire(a.id)}
              actionLabel="Retire"
              busy={busy}
            />
          ))}
        </div>
      )}

      {/* Generate / upload section. Three sources side-by-side:
          - manual_upload: drag-drop a file generated externally
          - voicebox: localhost generation from operator's Mac
          - openai: server-side OpenAI TTS (matches voice-bridge live calls) */}
      <details className="mb-3 rounded-[var(--radius-md)] border border-dashed border-[color:var(--color-border)] p-3">
        <summary className="cursor-pointer text-xs font-medium">
          Add audio
        </summary>

        <div className="mt-3 flex gap-1 text-[11px]">
          <TabButton
            active={genMode === 'manual'}
            onClick={() => setGenMode('manual')}
            label="Manual upload"
          />
          <TabButton
            active={genMode === 'openai'}
            onClick={() => setGenMode('openai')}
            label="OpenAI TTS"
            sub="matches your live-call voice"
          />
          <TabButton
            active={genMode === 'voicebox'}
            onClick={() => setGenMode('voicebox')}
            label="Voicebox"
            sub={
              voiceboxHealth?.ok
                ? `${voiceboxProfiles.length} profile(s)`
                : voiceboxHealth
                  ? 'not detected'
                  : 'detecting…'
            }
            disabled={voiceboxHealth ? !voiceboxHealth.ok : false}
          />
        </div>

        {genMode === 'manual' && (
          <ManualUploadForm
            probeId={probeId}
            probeOutreachLanguage={probeOutreachLanguage}
            variants={variants}
            busy={busy}
            onSubmit={(fd) => void handleUpload(fd)}
          />
        )}
        {genMode === 'openai' && (
          <OpenAIGenForm
            probeOutreachLanguage={probeOutreachLanguage}
            variants={variants}
            busy={busy}
            onSubmit={(input) => void handleOpenAIGenerate(input)}
          />
        )}
        {genMode === 'voicebox' && (
          <VoiceboxGenForm
            health={voiceboxHealth}
            profiles={voiceboxProfiles}
            probeOutreachLanguage={probeOutreachLanguage}
            variants={variants}
            busy={busy}
            onSubmit={(input) => void handleVoiceboxGenerate(input)}
          />
        )}
      </details>

      {/* Retired audit history */}
      {retiredAssets.length > 0 && (
        <details className="text-xs">
          <summary className="cursor-pointer text-[color:var(--color-muted-foreground)]">
            Retired ({retiredAssets.length})
          </summary>
          <div className="mt-2 space-y-2 opacity-70">
            {retiredAssets.map((a) => (
              <AudioAssetRowView
                key={a.id}
                asset={a}
                variants={variants}
                onAction={() => void handleReactivate(a.id)}
                actionLabel="Reactivate"
                busy={busy}
              />
            ))}
          </div>
        </details>
      )}
    </section>
  );
}

function AudioAssetRowView({
  asset,
  variants,
  onAction,
  actionLabel,
  busy,
}: {
  asset: AudioAssetRow;
  variants: VariantSummary[];
  onAction: () => void;
  actionLabel: string;
  busy: boolean;
}) {
  const variantName = asset.variantId
    ? variants.find((v) => v.id === asset.variantId)?.name ?? '(unknown variant)'
    : null;
  const durationSec = asset.durationMs
    ? Math.round(asset.durationMs / 100) / 10
    : null;
  return (
    <div className="grid gap-1 rounded-[var(--radius-md)] border border-[color:var(--color-border)] p-3">
      <div className="flex flex-wrap items-baseline gap-2 text-xs">
        <span className="rounded-full bg-[color:var(--color-muted)]/60 px-2 py-0.5 font-mono uppercase">
          {asset.language}
        </span>
        <span className="text-[color:var(--color-muted-foreground)]">
          {variantName ? `Variant: ${variantName}` : 'Probe default'}
        </span>
        <span className="text-[color:var(--color-muted-foreground)]">
          via {asset.generatedVia}
        </span>
        {durationSec != null && (
          <span className="text-[color:var(--color-muted-foreground)]">
            {durationSec}s
          </span>
        )}
        <button
          type="button"
          onClick={onAction}
          disabled={busy}
          className="ml-auto rounded-[var(--radius-sm)] border border-[color:var(--color-border)] px-2 py-0.5 text-[10px] hover:bg-[color:var(--color-muted)]/40 disabled:opacity-50"
        >
          {actionLabel}
        </button>
      </div>
      <audio controls src={asset.audioUrl} className="w-full" />
      <p className="text-[10px] text-[color:var(--color-muted-foreground)]">
        {asset.sourceText}
      </p>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  label,
  sub,
  disabled,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  sub?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`grid gap-0.5 rounded-[var(--radius-sm)] border px-2 py-1 text-left ${
        active
          ? 'border-[color:var(--color-foreground)] bg-[color:var(--color-muted)]/40'
          : 'border-[color:var(--color-border)] hover:bg-[color:var(--color-muted)]/20'
      } ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
    >
      <span>{label}</span>
      {sub && (
        <span className="text-[9px] text-[color:var(--color-muted-foreground)]">
          {sub}
        </span>
      )}
    </button>
  );
}

interface VariantSummary {
  id: string;
  name: string;
}

function ManualUploadForm({
  probeId,
  probeOutreachLanguage,
  variants,
  busy,
  onSubmit,
}: {
  probeId: string;
  probeOutreachLanguage: string | null;
  variants: VariantSummary[];
  busy: boolean;
  onSubmit: (fd: FormData) => void;
}) {
  return (
    <form
      className="mt-3 grid gap-2 text-xs"
      onSubmit={(e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        fd.set('probeId', probeId);
        fd.set('generatedVia', 'manual_upload');
        onSubmit(fd);
      }}
    >
      <label className="grid gap-1">
        <span>Audio file (.mp3 / .wav, max 5 MB)</span>
        <input
          type="file"
          name="file"
          accept="audio/mpeg,audio/mp3,audio/wav,audio/wave,audio/x-wav"
          required
          disabled={busy}
          className="text-xs"
        />
      </label>
      <SharedFormFields
        probeOutreachLanguage={probeOutreachLanguage}
        variants={variants}
        busy={busy}
      />
      <label className="grid gap-1">
        <span>Voice profile id (optional)</span>
        <input
          type="text"
          name="voiceProfileId"
          maxLength={200}
          disabled={busy}
          className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-1 py-0.5 font-mono"
        />
      </label>
      <button
        type="submit"
        disabled={busy}
        className="self-start rounded-[var(--radius-md)] bg-[color:var(--color-foreground)] px-3 py-1 text-xs font-medium text-[color:var(--color-background)] disabled:opacity-50"
      >
        {busy ? 'Uploading…' : 'Upload audio'}
      </button>
    </form>
  );
}

function OpenAIGenForm({
  probeOutreachLanguage,
  variants,
  busy,
  onSubmit,
}: {
  probeOutreachLanguage: string | null;
  variants: VariantSummary[];
  busy: boolean;
  onSubmit: (input: {
    text: string;
    voice: string;
    language: string;
    variantId: string | null;
    instructions?: string;
  }) => void;
}) {
  return (
    <form
      className="mt-3 grid gap-2 text-xs"
      onSubmit={(e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        const variantIdRaw = fd.get('variantId')?.toString();
        const instructionsRaw = fd.get('instructions')?.toString();
        onSubmit({
          text: fd.get('sourceText')?.toString() ?? '',
          voice: fd.get('voice')?.toString() ?? 'alloy',
          language: fd.get('language')?.toString() ?? 'en',
          variantId: variantIdRaw && variantIdRaw.length > 0 ? variantIdRaw : null,
          ...(instructionsRaw && instructionsRaw.length > 0
            ? { instructions: instructionsRaw }
            : {}),
        });
      }}
    >
      <p className="text-[10px] text-[color:var(--color-muted-foreground)]">
        Server-side TTS via OpenAI. Same voice your live outbound
        calls use (default <code>alloy</code>) so RVM and live-call
        personas match.
      </p>
      <label className="grid gap-1">
        <span>Voice</span>
        <select
          name="voice"
          defaultValue="alloy"
          disabled={busy}
          className="w-32 rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-1 py-0.5"
        >
          {OPENAI_VOICES.map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>
      </label>
      <SharedFormFields
        probeOutreachLanguage={probeOutreachLanguage}
        variants={variants}
        busy={busy}
      />
      <label className="grid gap-1">
        <span>
          Style instruction (optional — gpt-4o-mini-tts only,
          natural-language hint like &ldquo;warm, slow,
          conversational&rdquo;)
        </span>
        <input
          type="text"
          name="instructions"
          maxLength={500}
          disabled={busy}
          placeholder="warm, slow, conversational"
          className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-1 py-0.5"
        />
      </label>
      <button
        type="submit"
        disabled={busy}
        className="self-start rounded-[var(--radius-md)] bg-[color:var(--color-foreground)] px-3 py-1 text-xs font-medium text-[color:var(--color-background)] disabled:opacity-50"
      >
        {busy ? 'Generating…' : 'Generate via OpenAI'}
      </button>
    </form>
  );
}

function VoiceboxGenForm({
  health,
  profiles,
  probeOutreachLanguage,
  variants,
  busy,
  onSubmit,
}: {
  health: VoiceboxHealth | null;
  profiles: VoiceboxProfile[];
  probeOutreachLanguage: string | null;
  variants: VariantSummary[];
  busy: boolean;
  onSubmit: (input: {
    text: string;
    profileId: string;
    engine?: string;
    instruct?: string;
    language: string;
    variantId: string | null;
  }) => void;
}) {
  if (!health) {
    return (
      <p className="mt-3 text-xs text-[color:var(--color-muted-foreground)]">
        Detecting Voicebox at <code>http://127.0.0.1:17493</code>…
      </p>
    );
  }
  if (!health.ok) {
    return (
      <div className="mt-3 grid gap-1 text-xs">
        <p>
          Voicebox not detected on{' '}
          <code>http://127.0.0.1:17493</code>.
        </p>
        <p className="text-[10px] text-[color:var(--color-muted-foreground)]">
          Start Voicebox on this Mac to use it from procur. CORS:
          your Voicebox build must allow requests from procur&apos;s
          origin. If this dashboard is on https and Voicebox is on
          http localhost, modern browsers permit the fetch by
          default; some corporate-managed browsers block it.
          {health.reason && (
            <>
              <br />
              Reason: {health.reason}
            </>
          )}
        </p>
      </div>
    );
  }
  return (
    <form
      className="mt-3 grid gap-2 text-xs"
      onSubmit={(e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        const variantIdRaw = fd.get('variantId')?.toString();
        const engineRaw = fd.get('engine')?.toString();
        const instructRaw = fd.get('instruct')?.toString();
        onSubmit({
          text: fd.get('sourceText')?.toString() ?? '',
          profileId: fd.get('profileId')?.toString() ?? '',
          ...(engineRaw && engineRaw.length > 0
            ? { engine: engineRaw }
            : {}),
          ...(instructRaw && instructRaw.length > 0
            ? { instruct: instructRaw }
            : {}),
          language: fd.get('language')?.toString() ?? 'en',
          variantId: variantIdRaw && variantIdRaw.length > 0 ? variantIdRaw : null,
        });
      }}
    >
      <p className="text-[10px] text-[color:var(--color-muted-foreground)]">
        Voicebox detected
        {health.version && ` (v${health.version})`} —{' '}
        {profiles.length} profile(s) available. Audio generates on
        your machine; only the resulting bytes upload to procur.
      </p>
      <label className="grid gap-1">
        <span>Voice profile</span>
        <select
          name="profileId"
          required
          disabled={busy}
          // Single-profile Voiceboxes (the common case for an
          // operator with their own cloned voice) skip the picker —
          // the lone profile becomes the default. Multi-profile
          // setups still see the dropdown.
          defaultValue={profiles.length === 1 ? profiles[0]!.id : ''}
          className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-1 py-0.5"
        >
          {profiles.length !== 1 && (
            <option value="">— select profile —</option>
          )}
          {profiles.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
              {p.engine ? ` (${p.engine})` : ''}
              {p.language ? ` — ${p.language}` : ''}
            </option>
          ))}
        </select>
      </label>
      <SharedFormFields
        probeOutreachLanguage={probeOutreachLanguage}
        variants={variants}
        busy={busy}
      />
      <label className="grid gap-1">
        <span>Engine override (optional)</span>
        <input
          type="text"
          name="engine"
          placeholder="qwen_custom_voice"
          disabled={busy}
          className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-1 py-0.5 font-mono"
        />
      </label>
      <label className="grid gap-1">
        <span>Delivery instruction (optional)</span>
        <input
          type="text"
          name="instruct"
          placeholder="warm, slow, cinematic"
          disabled={busy}
          className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-1 py-0.5"
        />
      </label>
      <button
        type="submit"
        disabled={busy}
        className="self-start rounded-[var(--radius-md)] bg-[color:var(--color-foreground)] px-3 py-1 text-xs font-medium text-[color:var(--color-background)] disabled:opacity-50"
      >
        {busy ? 'Generating…' : 'Generate via Voicebox'}
      </button>
    </form>
  );
}

function SharedFormFields({
  probeOutreachLanguage,
  variants,
  busy,
}: {
  probeOutreachLanguage: string | null;
  variants: VariantSummary[];
  busy: boolean;
}) {
  return (
    <>
      <label className="grid gap-1">
        <span>Language (ISO 639-1 lowercase)</span>
        <input
          type="text"
          name="language"
          defaultValue={probeOutreachLanguage ?? 'en'}
          maxLength={2}
          pattern="[a-z]{2}"
          required
          disabled={busy}
          className="w-20 rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-1 py-0.5"
        />
      </label>
      <label className="grid gap-1">
        <span>Variant scope</span>
        <select
          name="variantId"
          disabled={busy}
          className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-1 py-0.5"
        >
          <option value="">Probe default (all variants)</option>
          {variants.map((v) => (
            <option key={v.id} value={v.id}>
              Variant: {v.name}
            </option>
          ))}
        </select>
      </label>
      <label className="grid gap-1">
        <span>
          Source text (transcript — what the audio says, for audit
          + retranslation)
        </span>
        <textarea
          name="sourceText"
          required
          maxLength={4000}
          rows={3}
          disabled={busy}
          placeholder="Hi, this is Cole at Procur — calling about your refinery's Q3 distillates supply…"
          className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-1 py-1"
        />
      </label>
    </>
  );
}
