'use client';

import { useState, useTransition } from 'react';

/**
 * "Qualify as lead" button for the entity profile page header.
 * Writes a lead row into procur's own DB (organizations + contacts +
 * leads) and surfaces the new lead's URL so the operator can click
 * straight into /leads/[id] for the next step.
 */
export function QualifyAsLeadButton({ slug }: { slug: string }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [leadUrl, setLeadUrl] = useState<string | null>(null);

  const onClick = () => {
    setError(null);
    startTransition(async () => {
      const res = await fetch(
        `/api/entities/${encodeURIComponent(slug)}/qualify-as-lead`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          message?: string;
          error?: string;
        };
        setError(body.message ?? body.error ?? `qualify failed (${res.status})`);
        return;
      }
      const body = (await res.json()) as { leadUrl?: string };
      if (body.leadUrl) {
        setLeadUrl(body.leadUrl);
        if (typeof window !== 'undefined') {
          window.open(body.leadUrl, '_blank', 'noopener,noreferrer');
        }
      }
    });
  };

  if (leadUrl) {
    return (
      <a
        href={leadUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1.5 rounded-[var(--radius-sm)] border border-[color:var(--color-border)] px-3 py-1 text-xs font-medium text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-foreground)]"
      >
        ✓ Open lead →
      </a>
    );
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        disabled={pending}
        onClick={onClick}
        title="Qualify this counterparty as a lead with full procur commercial context"
        className="inline-flex items-center gap-1.5 rounded-[var(--radius-sm)] border border-[color:var(--color-foreground)] bg-[color:var(--color-foreground)] px-3 py-1 text-xs font-medium text-[color:var(--color-background)] hover:opacity-90 disabled:opacity-40"
      >
        {pending ? 'Qualifying…' : 'Qualify as lead'}
      </button>
      {error && <span className="text-[10px] text-red-700">{error}</span>}
    </div>
  );
}
