'use client';

import { useState, useTransition } from 'react';
import { refreshApolloOrgAction } from '../actions';

/**
 * "Refresh from Apollo" button. Shown on the Corporate context
 * section when the entity has either a primary_domain or an
 * apollo_org_id. Force-refreshes the cache by setting freshness=0.
 */
export function RefreshApolloButton({ entitySlug }: { entitySlug: string }) {
  const [pending, startTransition] = useTransition();
  const [status, setStatus] = useState<{ ok: boolean; message: string } | null>(null);

  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        onClick={() => {
          setStatus(null);
          startTransition(async () => {
            const result = await refreshApolloOrgAction({ entitySlug });
            setStatus({ ok: result.ok, message: result.message });
          });
        }}
        disabled={pending}
        className="rounded-[var(--radius-md)] border border-[color:var(--color-border)] px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide hover:bg-[color:var(--color-muted)]/40 disabled:opacity-50"
      >
        {pending ? 'Refreshing…' : 'Refresh from Apollo'}
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
    </span>
  );
}
