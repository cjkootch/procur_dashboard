'use client';

import { useState, useTransition } from 'react';
import { searchApolloPeopleForEntityAction } from '../actions';
import type { ApolloSeniority } from '@procur/apollo';

/**
 * Inline "+ Find people" form for the Decision-makers panel.
 *
 * Free Apollo search (no credits consumed). Persists matched people
 * as pre-enrichment rows in entity_contact_enrichments — they
 * appear in the panel below this form on the next render.
 *
 * Keeps the UI surface minimal in v1: title contains + seniority
 * checkboxes + free-text keyword. Operators iterate as needed.
 */

const SENIORITY_OPTIONS: Array<{ value: ApolloSeniority; label: string }> = [
  { value: 'c_suite', label: 'C-suite' },
  { value: 'vp', label: 'VP' },
  { value: 'head', label: 'Head' },
  { value: 'director', label: 'Director' },
  { value: 'manager', label: 'Manager' },
];

export function FindApolloPeopleForm({ entitySlug }: { entitySlug: string }) {
  const [pending, startTransition] = useTransition();
  const [status, setStatus] = useState<{ ok: boolean; message: string } | null>(null);
  const [open, setOpen] = useState(false);
  const [titles, setTitles] = useState('');
  const [seniorities, setSeniorities] = useState<Set<ApolloSeniority>>(new Set());
  const [keywords, setKeywords] = useState('');

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-[var(--radius-md)] border border-[color:var(--color-border)] px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide hover:bg-[color:var(--color-muted)]/40"
      >
        + Find people
      </button>
    );
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        setStatus(null);
        startTransition(async () => {
          const personTitles = titles
            .split(',')
            .map((t) => t.trim())
            .filter(Boolean);
          const result = await searchApolloPeopleForEntityAction({
            entitySlug,
            personTitles: personTitles.length > 0 ? personTitles : undefined,
            personSeniorities:
              seniorities.size > 0 ? [...seniorities] : undefined,
            qKeywords: keywords || undefined,
          });
          setStatus({ ok: result.ok, message: result.message });
          if (result.ok) {
            setTitles('');
            setKeywords('');
            setSeniorities(new Set());
          }
        });
      }}
      className="mt-2 rounded-[var(--radius-lg)] border border-[color:var(--color-border)] p-3"
    >
      <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
        <label className="block">
          <span className="text-[10px] uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
            Titles (comma-separated)
          </span>
          <input
            type="text"
            value={titles}
            onChange={(event) => setTitles(event.target.value)}
            placeholder="procurement, supply chain"
            className="mt-1 w-full rounded-[var(--radius-md)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1 text-sm focus:border-[color:var(--color-foreground)] focus:outline-none"
          />
        </label>
        <label className="block">
          <span className="text-[10px] uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
            Keywords
          </span>
          <input
            type="text"
            value={keywords}
            onChange={(event) => setKeywords(event.target.value)}
            placeholder="fuel, bunker, logistics"
            className="mt-1 w-full rounded-[var(--radius-md)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1 text-sm focus:border-[color:var(--color-foreground)] focus:outline-none"
          />
        </label>
      </div>
      <div className="mt-2">
        <span className="text-[10px] uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
          Seniority
        </span>
        <div className="mt-1 flex flex-wrap gap-1">
          {SENIORITY_OPTIONS.map((opt) => {
            const checked = seniorities.has(opt.value);
            return (
              <button
                type="button"
                key={opt.value}
                onClick={() => {
                  setSeniorities((prev) => {
                    const next = new Set(prev);
                    if (next.has(opt.value)) next.delete(opt.value);
                    else next.add(opt.value);
                    return next;
                  });
                }}
                className={`rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wide ${
                  checked
                    ? 'border-[color:var(--color-foreground)] bg-[color:var(--color-foreground)] text-[color:var(--color-background)]'
                    : 'border-[color:var(--color-border)] hover:border-[color:var(--color-foreground)]'
                }`}
              >
                {opt.label}
              </button>
            );
          })}
        </div>
      </div>
      <div className="mt-3 flex items-center gap-2">
        <button
          type="submit"
          disabled={pending}
          className="rounded-[var(--radius-md)] border border-[color:var(--color-foreground)] bg-[color:var(--color-foreground)] px-3 py-1 text-xs font-medium uppercase tracking-wide text-[color:var(--color-background)] disabled:opacity-50"
        >
          {pending ? 'Searching…' : 'Search'}
        </button>
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            setStatus(null);
          }}
          className="rounded-[var(--radius-md)] border border-[color:var(--color-border)] px-3 py-1 text-xs font-medium hover:bg-[color:var(--color-muted)]/40"
        >
          Close
        </button>
        {status && (
          <span
            className={`text-[10px] ${
              status.ok
                ? 'text-emerald-700 dark:text-emerald-300'
                : 'text-amber-700 dark:text-amber-300'
            }`}
            role="status"
          >
            {status.message}
          </span>
        )}
      </div>
      <p className="mt-2 text-[10px] italic text-[color:var(--color-muted-foreground)]">
        Search is free. Results appear as pre-enrichment rows below.
        Clicking Enrich on a row consumes Apollo credits.
      </p>
    </form>
  );
}
