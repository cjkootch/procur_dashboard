'use client';

import { useState, useTransition } from 'react';

/**
 * "Qualify as lead" button for the entity profile page header.
 *
 * Phase 4 vex-into-procur merge: the underlying call now writes a
 * lead row into procur's own DB (organizations + contacts + leads)
 * rather than POSTing to the deleted vex HTTP API. Route URL stays
 * `push-to-vex` for back-compat with the existing button bookmark
 * + UI hooks; rename in a follow-up cleanup PR.
 */
export function PushToVexButton({ slug }: { slug: string }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [pushedUrl, setPushedUrl] = useState<string | null>(null);

  const onClick = () => {
    setError(null);
    startTransition(async () => {
      const res = await fetch(
        `/api/entities/${encodeURIComponent(slug)}/push-to-vex`,
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
        setError(body.message ?? body.error ?? `push failed (${res.status})`);
        return;
      }
      const body = (await res.json()) as { leadUrl?: string };
      if (body.leadUrl) {
        setPushedUrl(body.leadUrl);
        if (typeof window !== 'undefined') {
          window.open(body.leadUrl, '_blank', 'noopener,noreferrer');
        }
      }
    });
  };

  if (pushedUrl) {
    return (
      <a
        href={pushedUrl}
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
