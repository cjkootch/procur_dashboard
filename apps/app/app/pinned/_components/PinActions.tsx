'use client';

import { useTransition } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Extend / Unpin actions for a pinned match row. Extend bumps
 * expires_at by 30d; Unpin soft-deletes via revoked_at. Both
 * fire-and-forget; router.refresh re-renders the server-component
 * page after the mutation.
 */
export function PinActions({
  feedbackEventId,
  daysUntilExpiry,
}: {
  feedbackEventId: string;
  daysUntilExpiry: number;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const extend = () => {
    startTransition(async () => {
      const res = await fetch(`/api/feedback/pin/${feedbackEventId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'extend', days: 30 }),
      });
      if (res.ok) router.refresh();
    });
  };

  const unpin = () => {
    startTransition(async () => {
      const res = await fetch(`/api/feedback/pin/${feedbackEventId}`, {
        method: 'DELETE',
      });
      if (res.ok) router.refresh();
    });
  };

  return (
    <div className="flex gap-1">
      <button
        type="button"
        onClick={extend}
        disabled={pending}
        title={`Extend expiry by 30 days (currently ${daysUntilExpiry}d remaining)`}
        className="rounded border border-[color:var(--color-border)] px-1.5 py-0.5 text-[10px] hover:border-[color:var(--color-foreground)] disabled:opacity-40"
      >
        +30d
      </button>
      <button
        type="button"
        onClick={unpin}
        disabled={pending}
        title="Unpin"
        aria-label="Unpin"
        className="rounded border border-transparent px-1.5 py-0.5 text-[12px] leading-none text-[color:var(--color-muted-foreground)] hover:border-[color:var(--color-border)] hover:text-[color:var(--color-foreground)] disabled:opacity-40"
      >
        ×
      </button>
    </div>
  );
}
