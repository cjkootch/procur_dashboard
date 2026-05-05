'use client';

import { useState, useTransition } from 'react';
import { enrichApolloPersonAction } from '../actions';

/**
 * "Enrich" button for an individual pre-enrichment row in the
 * Decision-makers panel. Triggers a paid Apollo /people/match call
 * for this person, gated by the per-tenant per-day cap (default 25).
 *
 * On success, the page revalidates and the row re-renders with
 * full name + email + phone in place.
 */
export function EnrichApolloPersonButton({
  entitySlug,
  apolloPersonId,
}: {
  entitySlug: string;
  apolloPersonId: string;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  if (error) {
    return (
      <span
        className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[10px] uppercase tracking-wide text-amber-700 dark:text-amber-300"
        role="status"
      >
        {error}
      </span>
    );
  }

  return (
    <button
      type="button"
      onClick={() => {
        setError(null);
        startTransition(async () => {
          const result = await enrichApolloPersonAction({ entitySlug, apolloPersonId });
          if (!result.ok) setError(result.message);
        });
      }}
      disabled={pending}
      className="rounded-[var(--radius-md)] border border-[color:var(--color-foreground)] bg-[color:var(--color-foreground)] px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-[color:var(--color-background)] hover:opacity-90 disabled:opacity-50"
    >
      {pending ? 'Enriching…' : 'Enrich'}
    </button>
  );
}
