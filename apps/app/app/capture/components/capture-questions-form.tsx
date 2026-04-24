'use client';

import { useState, useTransition } from 'react';
import { saveCaptureAnswersAction } from '../actions';

type Incumbent = { name: string; notes: string };
type Competitor = { name: string; strengths: string; weaknesses: string };
type RiskMitigation = { risk: string; mitigation: string };
type CustomerRelationship = { name: string; role: string; notes: string };

export type CaptureAnswers = {
  winThemes: string[];
  customerBudget: number | null;
  customerPainPoints: string[];
  incumbents: Incumbent[];
  competitors: Competitor[];
  differentiators: string[];
  risksAndMitigations: RiskMitigation[];
  teamPartners: string[];
  customerRelationships: CustomerRelationship[];
  bidDecision?: 'pending' | 'bid' | 'no_bid';
  bidDecisionReasoning?: string;
};

function coerce(raw: unknown): CaptureAnswers {
  const o = (raw ?? {}) as Record<string, unknown>;
  return {
    winThemes: Array.isArray(o.winThemes) ? (o.winThemes as string[]) : [],
    customerBudget:
      typeof o.customerBudget === 'number'
        ? o.customerBudget
        : typeof o.customerBudget === 'string'
          ? Number.parseFloat(o.customerBudget) || null
          : null,
    customerPainPoints: Array.isArray(o.customerPainPoints)
      ? (o.customerPainPoints as string[])
      : [],
    incumbents: Array.isArray(o.incumbents) ? (o.incumbents as Incumbent[]) : [],
    competitors: Array.isArray(o.competitors) ? (o.competitors as Competitor[]) : [],
    differentiators: Array.isArray(o.differentiators)
      ? (o.differentiators as string[])
      : [],
    risksAndMitigations: Array.isArray(o.risksAndMitigations)
      ? (o.risksAndMitigations as RiskMitigation[])
      : [],
    teamPartners: Array.isArray(o.teamPartners) ? (o.teamPartners as string[]) : [],
    customerRelationships: Array.isArray(o.customerRelationships)
      ? (o.customerRelationships as CustomerRelationship[])
      : [],
    bidDecision:
      o.bidDecision === 'bid' || o.bidDecision === 'no_bid' ? o.bidDecision : 'pending',
    bidDecisionReasoning:
      typeof o.bidDecisionReasoning === 'string' ? o.bidDecisionReasoning : '',
  };
}

export function CaptureQuestionsForm({
  pursuitId,
  initial,
}: {
  pursuitId: string;
  initial: unknown;
}) {
  const [answers, setAnswers] = useState<CaptureAnswers>(() => coerce(initial));
  const [saving, startTransition] = useTransition();
  const [savedAt, setSavedAt] = useState<Date | null>(null);

  const handleSave = () => {
    const fd = new FormData();
    fd.set('pursuitId', pursuitId);
    fd.set('answers', JSON.stringify(answers));
    startTransition(async () => {
      await saveCaptureAnswersAction(fd);
      setSavedAt(new Date());
    });
  };

  const set = <K extends keyof CaptureAnswers>(key: K, value: CaptureAnswers[K]) =>
    setAnswers((a) => ({ ...a, [key]: value }));

  return (
    <div className="rounded-[var(--radius-lg)] border border-[color:var(--color-border)] p-5">
      <div className="space-y-6">
        <Field label="Win themes" help="The 2-5 messages that should land in the customer's mind.">
          <StringListInput
            value={answers.winThemes}
            onChange={(v) => set('winThemes', v)}
            placeholder="e.g. Lowest-risk delivery in the Caribbean"
          />
        </Field>

        <Field label="Customer budget (USD)" help="Best estimate. Leave blank if truly unknown.">
          <input
            type="number"
            min="0"
            step="1000"
            value={answers.customerBudget ?? ''}
            onChange={(e) =>
              set(
                'customerBudget',
                e.target.value === '' ? null : Number.parseFloat(e.target.value),
              )
            }
            className="w-full max-w-xs rounded-[var(--radius-sm)] border border-[color:var(--color-border)] px-2 py-1 text-sm"
          />
        </Field>

        <Field label="Customer pain points" help="What are they actually trying to fix?">
          <StringListInput
            value={answers.customerPainPoints}
            onChange={(v) => set('customerPainPoints', v)}
            placeholder="e.g. Long procurement lead times from local suppliers"
          />
        </Field>

        <Field
          label="Incumbents"
          help="Who currently holds this or a similar contract? What's our relationship?"
        >
          <RecordListInput
            value={answers.incumbents}
            onChange={(v) => set('incumbents', v)}
            template={{ name: '', notes: '' }}
            fields={[
              { key: 'name', label: 'Incumbent name', placeholder: 'ACME Corp' },
              { key: 'notes', label: 'Relationship notes', placeholder: 'Lost last RFP on price…' },
            ]}
          />
        </Field>

        <Field label="Competitors" help="Main competitors for this bid and their known strengths / weaknesses.">
          <RecordListInput
            value={answers.competitors}
            onChange={(v) => set('competitors', v)}
            template={{ name: '', strengths: '', weaknesses: '' }}
            fields={[
              { key: 'name', label: 'Competitor', placeholder: 'ACME Corp' },
              { key: 'strengths', label: 'Strengths', placeholder: 'Local presence, low labor rates' },
              { key: 'weaknesses', label: 'Weaknesses', placeholder: 'No experience above $5M' },
            ]}
          />
        </Field>

        <Field label="Our differentiators" help="What makes us materially different for this opportunity?">
          <StringListInput
            value={answers.differentiators}
            onChange={(v) => set('differentiators', v)}
            placeholder="e.g. Only bidder with in-country engineering team"
          />
        </Field>

        <Field
          label="Top risks and mitigations"
          help="List the 3-5 things most likely to blow this up."
        >
          <RecordListInput
            value={answers.risksAndMitigations}
            onChange={(v) => set('risksAndMitigations', v)}
            template={{ risk: '', mitigation: '' }}
            fields={[
              { key: 'risk', label: 'Risk', placeholder: 'Customer may tighten local-content rules' },
              { key: 'mitigation', label: 'Mitigation', placeholder: 'Teaming agreement with local SME' },
            ]}
          />
        </Field>

        <Field label="Team / partners" help="Subs, teaming partners, advisors lined up for this bid.">
          <StringListInput
            value={answers.teamPartners}
            onChange={(v) => set('teamPartners', v)}
            placeholder="e.g. Local Engineering Ltd (electrical sub)"
          />
        </Field>

        <Field
          label="Customer relationships"
          help="People on the buyer side we've spoken to or have standing with."
        >
          <RecordListInput
            value={answers.customerRelationships}
            onChange={(v) => set('customerRelationships', v)}
            template={{ name: '', role: '', notes: '' }}
            fields={[
              { key: 'name', label: 'Name', placeholder: 'Jane Smith' },
              { key: 'role', label: 'Role', placeholder: 'Director of Procurement' },
              { key: 'notes', label: 'Notes', placeholder: 'Worked together on 2024 highway bid' },
            ]}
          />
        </Field>

        <Field label="Bid / no-bid decision" help="Lock it in before moving to Proposal Development.">
          <div className="flex flex-col gap-3">
            <div className="flex gap-2 text-sm">
              {(['pending', 'bid', 'no_bid'] as const).map((opt) => {
                const label = opt === 'no_bid' ? 'No bid' : opt === 'bid' ? 'Bid' : 'Pending';
                const active = answers.bidDecision === opt;
                return (
                  <button
                    key={opt}
                    type="button"
                    onClick={() => set('bidDecision', opt)}
                    className={`rounded-full border px-3 py-1 ${
                      active
                        ? 'border-[color:var(--color-foreground)] bg-[color:var(--color-foreground)] text-[color:var(--color-background)]'
                        : 'border-[color:var(--color-border)]'
                    }`}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
            <textarea
              rows={3}
              value={answers.bidDecisionReasoning ?? ''}
              onChange={(e) => set('bidDecisionReasoning', e.target.value)}
              placeholder="Why this decision? One paragraph."
              className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] px-2 py-1 text-sm"
            />
          </div>
        </Field>
      </div>

      <div className="mt-6 flex items-center gap-3">
        <button
          type="button"
          onClick={handleSave}
          disabled={saving}
          className="rounded-[var(--radius-md)] bg-[color:var(--color-foreground)] px-4 py-2 text-sm font-medium text-[color:var(--color-background)] disabled:opacity-50"
        >
          {saving ? 'Saving…' : 'Save answers'}
        </button>
        {savedAt && (
          <span className="text-xs text-[color:var(--color-muted-foreground)]">
            Saved {savedAt.toLocaleTimeString()}
          </span>
        )}
      </div>
    </div>
  );
}

function Field({
  label,
  help,
  children,
}: {
  label: string;
  help?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <p className="text-sm font-medium">{label}</p>
      {help && <p className="mt-0.5 text-xs text-[color:var(--color-muted-foreground)]">{help}</p>}
      <div className="mt-2">{children}</div>
    </div>
  );
}

function StringListInput({
  value,
  onChange,
  placeholder,
}: {
  value: string[];
  onChange: (v: string[]) => void;
  placeholder?: string;
}) {
  return (
    <div className="space-y-2">
      {value.map((item, i) => (
        <div key={i} className="flex gap-2">
          <input
            type="text"
            value={item}
            onChange={(e) => {
              const next = [...value];
              next[i] = e.target.value;
              onChange(next);
            }}
            placeholder={placeholder}
            className="flex-1 rounded-[var(--radius-sm)] border border-[color:var(--color-border)] px-2 py-1 text-sm"
          />
          <button
            type="button"
            onClick={() => onChange(value.filter((_, j) => j !== i))}
            className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] px-2 text-xs text-[color:var(--color-muted-foreground)] hover:border-[color:var(--color-foreground)]"
            aria-label="Remove"
          >
            ×
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() => onChange([...value, ''])}
        className="text-xs underline text-[color:var(--color-muted-foreground)]"
      >
        + Add
      </button>
    </div>
  );
}

function RecordListInput<T extends Record<string, string>>({
  value,
  onChange,
  template,
  fields,
}: {
  value: T[];
  onChange: (v: T[]) => void;
  template: T;
  fields: Array<{ key: keyof T; label: string; placeholder?: string }>;
}) {
  return (
    <div className="space-y-3">
      {value.map((item, i) => (
        <div
          key={i}
          className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] p-3"
        >
          <div className="grid gap-2">
            {fields.map((f) => (
              <label key={String(f.key)} className="flex flex-col gap-1 text-xs">
                <span className="text-[color:var(--color-muted-foreground)]">{f.label}</span>
                <input
                  type="text"
                  value={item[f.key] ?? ''}
                  onChange={(e) => {
                    const next = [...value];
                    next[i] = { ...next[i], [f.key]: e.target.value } as T;
                    onChange(next);
                  }}
                  placeholder={f.placeholder}
                  className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] px-2 py-1 text-sm"
                />
              </label>
            ))}
          </div>
          <button
            type="button"
            onClick={() => onChange(value.filter((_, j) => j !== i))}
            className="mt-2 text-xs text-[color:var(--color-muted-foreground)] hover:underline"
          >
            Remove
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() => onChange([...value, { ...template }])}
        className="text-xs underline text-[color:var(--color-muted-foreground)]"
      >
        + Add entry
      </button>
    </div>
  );
}
