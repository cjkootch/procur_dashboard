'use client';

import { useEffect, useState, useTransition } from 'react';
import type { ConversationSettings } from '@procur/db';

/**
 * Right-rail panel for per-conversation agent settings. Mounted on
 * /messages/[phone] (sms / whatsapp) and /inbox/[threadId] (email).
 *
 * Slice 1 of the conversation-agent system: storage + UI only. AI
 * is off by default; toggling on stores the setting but no agent
 * runtime reads it yet (Slices 2 + 3 wire the inbound webhook →
 * agent path).
 *
 * Save model:
 *   - Toggles, selects, and number inputs → auto-save on change
 *     (single-action fields, no rapid input).
 *   - Text inputs / textareas → save on blur only. Live text edits
 *     hold local draft state; we DON'T fire a PATCH per keystroke
 *     (each PATCH re-renders the panel, which lost focus mid-typing
 *     in the original implementation).
 *   - On PATCH success we DO NOT overwrite local state from the
 *     server snapshot. The optimistic value is good enough; the
 *     server response only matters for error rollback.
 */
export function ConversationSettingsPanel({
  initialSettings,
  channel,
  conversationKey,
}: {
  initialSettings: ConversationSettings;
  channel: 'sms' | 'whatsapp' | 'email';
  conversationKey: string;
}) {
  const [settings, setSettings] = useState<ConversationSettings>(initialSettings);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const patch = (updates: Partial<ConversationSettings>) => {
    // Optimistic local update.
    setSettings((prev) => ({ ...prev, ...updates }));
    setError(null);
    startTransition(async () => {
      try {
        const res = await fetch('/api/conversation-settings', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            channel,
            conversation_key: conversationKey,
            patch: updates,
          }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          throw new Error(body.error ?? `HTTP ${res.status}`);
        }
        // Intentionally NOT calling setSettings(body.settings) here.
        // Re-rendering with the server snapshot during in-flight
        // edits clobbers the user's typed input. Optimistic value is
        // already in state; server response only matters on error.
      } catch (err) {
        setError(err instanceof Error ? err.message : 'save failed');
        // Roll back the offending fields. We don't have the
        // pre-patch values here so reset the whole row to the most
        // recent server snapshot we have (the initial). Fine for
        // recovery — operator can re-edit.
        setSettings(initialSettings);
      }
    });
  };

  return (
    <aside className="flex w-full flex-col gap-5 border-l border-[color:var(--color-border)] bg-[color:var(--color-muted)]/20 p-4 lg:w-80 lg:overflow-y-auto">
      <header className="flex items-baseline justify-between">
        <h2 className="text-sm font-semibold tracking-tight">
          Conversation settings
        </h2>
        <span
          className={`text-[10px] uppercase tracking-wide ${
            settings.aiEnabled
              ? 'text-emerald-700'
              : 'text-[color:var(--color-muted-foreground)]'
          }`}
        >
          {settings.aiEnabled ? '● AI on' : '○ AI off'}
        </span>
      </header>

      {/* AI master toggle */}
      <Section title="Automation">
        <Toggle
          label="AI auto-reply"
          description="Let the agent draft and (per approval mode) send replies on your behalf."
          checked={settings.aiEnabled}
          onChange={(v) => patch({ aiEnabled: v })}
          disabled={pending}
        />

        {settings.aiEnabled && (
          <>
            <Select
              label="Authority"
              hint="What the AI is allowed to commit to."
              value={settings.authority}
              options={[
                { value: 'chitchat_only', label: 'Chitchat only' },
                { value: 'ranges_only', label: 'Quote ranges only' },
                { value: 'commit_with_approval', label: 'Commit (with approval)' },
              ]}
              onChange={(v) =>
                patch({ authority: v as ConversationSettings['authority'] })
              }
              disabled={pending}
            />
            <Select
              label="Approval mode"
              hint="When does an AI reply require your sign-off?"
              value={settings.approvalMode}
              options={[
                { value: 'full_approval', label: 'Always — every reply' },
                { value: 'tiered', label: 'Tiered — only sensitive replies' },
                {
                  value: 'business_hours_only',
                  label: 'Business hours only',
                },
              ]}
              onChange={(v) =>
                patch({
                  approvalMode: v as ConversationSettings['approvalMode'],
                })
              }
              disabled={pending}
            />
          </>
        )}
      </Section>

      {/* Goal */}
      <Section title="Goal">
        <Select
          label="Objective"
          value={settings.objective ?? ''}
          options={[
            { value: '', label: '(none)' },
            { value: 'qualify', label: 'Qualify lead' },
            { value: 'book_meeting', label: 'Book a meeting' },
            { value: 'get_pricing', label: 'Get pricing intent' },
            { value: 'support', label: 'Support / clarify' },
            { value: 'close_deal', label: 'Close deal' },
            { value: 'custom', label: 'Custom' },
          ]}
          onChange={(v) =>
            patch({
              objective: (v || null) as ConversationSettings['objective'],
            })
          }
          disabled={pending}
        />
        <Textarea
          label="Custom prompt"
          hint="Extra instructions appended to the agent's system prompt for this convo only."
          value={settings.customPrompt ?? ''}
          onChange={(v) => patch({ customPrompt: v || null })}
          rows={4}
        />
      </Section>

      {/* Persona */}
      <Section title="Persona">
        <Select
          label="Tone"
          value={settings.tone}
          options={[
            { value: 'brokerage_direct', label: 'Brokerage-direct' },
            { value: 'formal', label: 'Formal' },
            { value: 'casual', label: 'Casual' },
          ]}
          onChange={(v) =>
            patch({ tone: v as ConversationSettings['tone'] })
          }
          disabled={pending}
        />
        <Select
          label="Language"
          value={settings.language}
          options={[
            { value: 'auto', label: 'Auto-detect' },
            { value: 'en', label: 'English' },
            { value: 'es', label: 'Spanish' },
            { value: 'pt', label: 'Portuguese' },
            { value: 'fr', label: 'French' },
            { value: 'ar', label: 'Arabic' },
          ]}
          onChange={(v) => patch({ language: v })}
          disabled={pending}
        />
        <Select
          label="Disclose AI?"
          hint="When recipient asks 'is this a person?'"
          value={settings.identityDisclosure}
          options={[
            { value: 'on_request', label: 'On request' },
            { value: 'always', label: 'Always upfront' },
            { value: 'never', label: 'Never (be cautious)' },
          ]}
          onChange={(v) =>
            patch({
              identityDisclosure:
                v as ConversationSettings['identityDisclosure'],
            })
          }
          disabled={pending}
        />
      </Section>

      {/* Cadence */}
      <Section title="Cadence">
        <NumberPair
          label="Response delay (sec)"
          minLabel="min"
          maxLabel="max"
          minValue={settings.responseDelayMinSec}
          maxValue={settings.responseDelayMaxSec}
          onChange={(min, max) =>
            patch({ responseDelayMinSec: min, responseDelayMaxSec: max })
          }
        />
        {channel !== 'email' && (
          <NumberPair
            label="Quiet hours (recipient local)"
            minLabel="start"
            maxLabel="end"
            minValue={settings.quietHoursStartLocal ?? 0}
            maxValue={settings.quietHoursEndLocal ?? 0}
            onChange={(min, max) =>
              patch({
                quietHoursStartLocal: min,
                quietHoursEndLocal: max,
              })
            }
          />
        )}
      </Section>

      {/* Budget */}
      <Section title="Budget">
        <NumberInput
          label="Max turns"
          hint="Force handoff after this many AI turns."
          value={settings.maxTurns}
          onChange={(v) => patch({ maxTurns: v })}
        />
        <NumberInput
          label="Max cost (USD ¢)"
          hint="Forced cap on this conversation's LLM spend."
          value={settings.maxCostUsdCents}
          onChange={(v) => patch({ maxCostUsdCents: v })}
        />
        <NumberInput
          label="Max duration (hours)"
          value={settings.maxDurationHours}
          onChange={(v) => patch({ maxDurationHours: v })}
        />
      </Section>

      {/* Counters / state — read-only */}
      <Section title="State">
        <ReadOnly label="Turns used" value={String(settings.totalTurns)} />
        <ReadOnly
          label="Cost used"
          value={`$${(Number(settings.totalCostUsdMicros) / 1_000_000).toFixed(4)}`}
        />
        {settings.pausedAt && (
          <ReadOnly
            label="Paused"
            value={`${new Date(settings.pausedAt).toLocaleString()} · ${settings.pausedReason ?? '(no reason)'}`}
          />
        )}
      </Section>

      {error && (
        <p className="text-xs text-red-700" role="alert">
          {error}
        </p>
      )}
      <p className="text-[10px] text-[color:var(--color-muted-foreground)]">
        Slice 1 — storage only. Inbound-message → AI-reply path ships
        in Slice 2 (sms/whatsapp) and Slice 3 (email).
      </p>
    </aside>
  );
}

// ──────────────────────────────────────────────────────────────────
// Form primitives — kept in this file because they're only used here.
// ──────────────────────────────────────────────────────────────────

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3">
      <h3 className="text-[10px] font-semibold uppercase tracking-wider text-[color:var(--color-muted-foreground)]">
        {title}
      </h3>
      <div className="flex flex-col gap-3">{children}</div>
    </section>
  );
}

function Toggle({
  label,
  description,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-3">
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition disabled:opacity-40 ${
          checked
            ? 'bg-emerald-500'
            : 'bg-[color:var(--color-muted)]'
        }`}
      >
        <span
          className={`inline-block h-4 w-4 rounded-full bg-white shadow transition-transform ${
            checked ? 'translate-x-4' : 'translate-x-0.5'
          }`}
        />
      </button>
      <div className="min-w-0">
        <p className="text-sm">{label}</p>
        {description && (
          <p className="mt-0.5 text-[11px] text-[color:var(--color-muted-foreground)]">
            {description}
          </p>
        )}
      </div>
    </label>
  );
}

function Select({
  label,
  hint,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string;
  hint?: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10px] uppercase tracking-wider text-[color:var(--color-muted-foreground)]">
        {label}
      </span>
      <select
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1 text-sm focus:border-[color:var(--color-foreground)] focus:outline-none disabled:opacity-40"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {hint && (
        <span className="text-[10px] text-[color:var(--color-muted-foreground)]">
          {hint}
        </span>
      )}
    </label>
  );
}

function NumberInput({
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  hint?: string;
  value: number;
  onChange: (v: number) => void;
}) {
  // Same blur-commit pattern as Textarea — typing per-keystroke
  // PATCH would also reset focus on the number input.
  const [draft, setDraft] = useState(String(value));
  useEffect(() => {
    setDraft(String(value));
  }, [value]);

  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10px] uppercase tracking-wider text-[color:var(--color-muted-foreground)]">
        {label}
      </span>
      <input
        type="number"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          const next = Number(draft);
          if (!Number.isNaN(next) && next !== value) onChange(next);
        }}
        className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1 text-sm focus:border-[color:var(--color-foreground)] focus:outline-none"
      />
      {hint && (
        <span className="text-[10px] text-[color:var(--color-muted-foreground)]">
          {hint}
        </span>
      )}
    </label>
  );
}

function NumberPair({
  label,
  minLabel,
  maxLabel,
  minValue,
  maxValue,
  onChange,
}: {
  label: string;
  minLabel: string;
  maxLabel: string;
  minValue: number;
  maxValue: number;
  onChange: (min: number, max: number) => void;
}) {
  // Blur-commit on both halves; live drafts so typing doesn't fight
  // a parent re-render.
  const [minDraft, setMinDraft] = useState(String(minValue));
  const [maxDraft, setMaxDraft] = useState(String(maxValue));
  useEffect(() => {
    setMinDraft(String(minValue));
  }, [minValue]);
  useEffect(() => {
    setMaxDraft(String(maxValue));
  }, [maxValue]);

  const commit = (rawMin: string, rawMax: string) => {
    const nextMin = Number(rawMin);
    const nextMax = Number(rawMax);
    if (Number.isNaN(nextMin) || Number.isNaN(nextMax)) return;
    if (nextMin === minValue && nextMax === maxValue) return;
    onChange(nextMin, nextMax);
  };

  return (
    <div className="flex flex-col gap-1">
      <span className="text-[10px] uppercase tracking-wider text-[color:var(--color-muted-foreground)]">
        {label}
      </span>
      <div className="flex items-center gap-2 text-sm">
        <span className="text-[10px] text-[color:var(--color-muted-foreground)]">
          {minLabel}
        </span>
        <input
          type="number"
          value={minDraft}
          onChange={(e) => setMinDraft(e.target.value)}
          onBlur={() => commit(minDraft, maxDraft)}
          className="w-16 rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1"
        />
        <span className="text-[10px] text-[color:var(--color-muted-foreground)]">
          {maxLabel}
        </span>
        <input
          type="number"
          value={maxDraft}
          onChange={(e) => setMaxDraft(e.target.value)}
          onBlur={() => commit(minDraft, maxDraft)}
          className="w-16 rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1"
        />
      </div>
    </div>
  );
}

function Textarea({
  label,
  hint,
  value,
  onChange,
  rows = 3,
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (v: string) => void;
  rows?: number;
}) {
  // Local draft holds the typing-in-progress text. We only call
  // `onChange` (which fires PATCH) on blur — typing per-keystroke
  // would PATCH on every key, re-render the parent, and lose focus.
  // Sync from the prop only when the prop changes from outside
  // (e.g. operator switches to a different conversation).
  const [draft, setDraft] = useState(value);
  useEffect(() => {
    setDraft(value);
  }, [value]);

  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10px] uppercase tracking-wider text-[color:var(--color-muted-foreground)]">
        {label}
      </span>
      <textarea
        value={draft}
        rows={rows}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          if (draft !== value) onChange(draft);
        }}
        className="resize-y rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1 text-sm focus:border-[color:var(--color-foreground)] focus:outline-none"
      />
      {hint && (
        <span className="text-[10px] text-[color:var(--color-muted-foreground)]">
          {hint}
        </span>
      )}
    </label>
  );
}

function ReadOnly({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] uppercase tracking-wider text-[color:var(--color-muted-foreground)]">
        {label}
      </span>
      <span className="text-sm">{value}</span>
    </div>
  );
}
