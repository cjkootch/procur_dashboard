'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { DealRetrospectiveRow, ProcurInsightMatteredValue } from '@procur/catalog';

const SIGNAL_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'procur_match_queue', label: 'Procur match-queue' },
  { value: 'direct_counterparty', label: 'Direct counterparty conversation' },
  { value: 'broker_intro', label: 'Broker introduction' },
  { value: 'news_media', label: 'News / media coverage' },
  { value: 'other', label: 'Other' },
];

const INSIGHT_OPTIONS: Array<{ value: ProcurInsightMatteredValue; label: string }> = [
  { value: 'yes_materially', label: 'Yes, materially' },
  { value: 'yes_marginally', label: 'Yes, marginally' },
  { value: 'no', label: 'No' },
  { value: 'na', label: 'N/A' },
];

export function RetrospectiveForm({
  dealId,
  initial,
  defaultOutcome,
}: {
  dealId: string;
  initial: DealRetrospectiveRow | null;
  defaultOutcome: 'won' | 'lost' | 'dead';
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [draft, setDraft] = useState({
    dealOutcome: initial?.dealOutcome ?? defaultOutcome,
    initialSignalSource: initial?.initialSignalSource ?? '',
    daysSignalToClose: initial?.daysSignalToClose ?? '',
    criticalMoments: initial?.criticalMoments ?? '',
    procurInsightMattered: (initial?.procurInsightMattered ?? '') as
      | ProcurInsightMatteredValue
      | '',
    whatWouldHaveHelped: initial?.whatWouldHaveHelped ?? '',
    patternForFuture: initial?.patternForFuture ?? '',
  });

  const submit = (isDraft: boolean) => {
    startTransition(async () => {
      const res = await fetch('/api/feedback/retrospective', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          dealId,
          dealOutcome: draft.dealOutcome,
          initialSignalSource: draft.initialSignalSource || null,
          daysSignalToClose:
            draft.daysSignalToClose === '' ? null : Number(draft.daysSignalToClose),
          criticalMoments: draft.criticalMoments || null,
          procurInsightMattered: draft.procurInsightMattered || null,
          whatWouldHaveHelped: draft.whatWouldHaveHelped || null,
          patternForFuture: draft.patternForFuture || null,
          isDraft,
        }),
      });
      if (res.ok) router.refresh();
    });
  };

  const completed = initial?.completedAt && !initial.isDraft;

  return (
    <div className="space-y-4">
      {completed && (
        <div className="rounded border border-emerald-500/40 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
          ✓ Retrospective completed. You can update fields below; saving keeps the completion timestamp.
        </div>
      )}

      <Field label="Outcome">
        <select
          value={draft.dealOutcome}
          onChange={(e) =>
            setDraft({ ...draft, dealOutcome: e.target.value as 'won' | 'lost' | 'dead' })
          }
          disabled={pending}
          className="rounded border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1 text-sm"
        >
          <option value="won">Won</option>
          <option value="lost">Lost</option>
          <option value="dead">Dead</option>
        </select>
      </Field>

      <Field label="What signal first surfaced this opportunity?">
        <select
          value={draft.initialSignalSource}
          onChange={(e) => setDraft({ ...draft, initialSignalSource: e.target.value })}
          disabled={pending}
          className="rounded border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1 text-sm"
        >
          <option value="">—</option>
          {SIGNAL_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </Field>

      <Field label="How long from first signal to deal closure? (days)">
        <input
          type="number"
          min={0}
          value={draft.daysSignalToClose}
          onChange={(e) => setDraft({ ...draft, daysSignalToClose: e.target.value })}
          disabled={pending}
          className="w-32 rounded border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1 text-sm"
        />
      </Field>

      <Field label="What were the 1-2 critical moments that determined the outcome?">
        <textarea
          value={draft.criticalMoments}
          onChange={(e) => setDraft({ ...draft, criticalMoments: e.target.value })}
          disabled={pending}
          rows={3}
          className="w-full rounded border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1 text-sm"
        />
      </Field>

      <Field label="Did procur surface any insight that mattered to the outcome?">
        <div className="flex flex-wrap gap-3">
          {INSIGHT_OPTIONS.map((o) => (
            <label key={o.value} className="flex items-center gap-1 text-sm">
              <input
                type="radio"
                name="procurInsightMattered"
                value={o.value}
                checked={draft.procurInsightMattered === o.value}
                onChange={() =>
                  setDraft({ ...draft, procurInsightMattered: o.value })
                }
                disabled={pending}
              />
              {o.label}
            </label>
          ))}
        </div>
      </Field>

      <Field label="What would have made this deal close faster or with better economics?">
        <textarea
          value={draft.whatWouldHaveHelped}
          onChange={(e) => setDraft({ ...draft, whatWouldHaveHelped: e.target.value })}
          disabled={pending}
          rows={3}
          className="w-full rounded border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1 text-sm"
        />
      </Field>

      <Field label="What pattern from this deal should we apply to similar future deals?">
        <textarea
          value={draft.patternForFuture}
          onChange={(e) => setDraft({ ...draft, patternForFuture: e.target.value })}
          disabled={pending}
          rows={3}
          className="w-full rounded border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1 text-sm"
        />
      </Field>

      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={() => submit(true)}
          disabled={pending}
          className="rounded border border-[color:var(--color-border)] px-3 py-1 text-sm hover:border-[color:var(--color-foreground)] disabled:opacity-40"
        >
          Save Draft
        </button>
        <button
          type="button"
          onClick={() => submit(false)}
          disabled={pending}
          className="rounded bg-[color:var(--color-foreground)] px-3 py-1 text-sm text-[color:var(--color-background)] hover:opacity-90 disabled:opacity-40"
        >
          {completed ? 'Update' : 'Save Retrospective'}
        </button>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1 text-xs font-medium text-[color:var(--color-foreground)]">{label}</div>
      {children}
    </div>
  );
}
