'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { CurrentDispositionRow, EntityDispositionValue } from '@procur/catalog';

const OPTIONS: Array<{ value: EntityDispositionValue; label: string; helper: string }> = [
  { value: 'active_pursuing', label: 'Active — pursuing', helper: 'concrete opportunity in flight' },
  { value: 'active_exploratory', label: 'Active — exploratory', helper: 'still scoping fit' },
  { value: 'dormant', label: 'Dormant', helper: 'paused, may revisit' },
  { value: 'dead', label: 'Dead', helper: 'no commercial path' },
  { value: 'declined', label: 'Declined — for cause', helper: 'requires reason' },
  { value: 'never_contacted', label: 'Never contacted', helper: 'system default' },
];

/**
 * Pattern 4 (disposition tracking) per docs/feedback-ui-brief.md §7.
 *
 * Always-available picker on the entity profile. Brief specs a
 * post-interaction prompt; we ship the persistent panel first
 * because procur doesn't yet have a unified logged-interaction
 * pipeline to hook the prompt into. Same data shape, lower friction
 * to ship.
 *
 * Stale indicator (30+ days) per brief §7.3 — rendered next to
 * the current value so it's visible across surfaces.
 */
export function DispositionPanel({
  entitySlug,
  current,
}: {
  entitySlug: string;
  current: CurrentDispositionRow | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [pickValue, setPickValue] = useState<EntityDispositionValue>(
    current?.disposition ?? 'never_contacted',
  );
  const [reason, setReason] = useState(current?.declineReason ?? '');

  const submit = () => {
    if (pickValue === 'declined' && reason.trim().length === 0) return;
    startTransition(async () => {
      const res = await fetch('/api/feedback/disposition', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          entitySlug,
          disposition: pickValue,
          declineReason: pickValue === 'declined' ? reason.trim() : null,
          oldDisposition: current?.disposition ?? null,
        }),
      });
      if (res.ok) {
        setOpen(false);
        router.refresh();
      }
    });
  };

  const currentOption = OPTIONS.find((o) => o.value === current?.disposition);

  return (
    <section className="mb-6 rounded-md border border-[color:var(--color-border)]/60 bg-[color:var(--color-muted)]/30 p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 className="text-xs font-medium uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
          Disposition
        </h2>
        <div className="flex items-center gap-2 text-xs">
          <span className="text-[color:var(--color-foreground)]">
            {currentOption?.label ?? 'Never contacted'}
          </span>
          {current?.isStale && (
            <span
              className="rounded bg-amber-500/15 px-1 text-[10px] text-amber-800"
              title="Last set >30 days ago — refresh to keep your relationship state honest"
            >
              ⚠️ stale
            </span>
          )}
          {current?.disposition === 'declined' && current.declineReason && (
            <span
              className="text-[10px] italic text-[color:var(--color-muted-foreground)]"
              title={current.declineReason}
            >
              ({truncate(current.declineReason, 40)})
            </span>
          )}
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            className="rounded border border-[color:var(--color-border)] px-1.5 py-0.5 text-[11px] hover:border-[color:var(--color-foreground)]"
          >
            {open ? 'Cancel' : 'Update'}
          </button>
        </div>
      </div>

      {open && (
        <div className="space-y-2">
          <ul className="space-y-1">
            {OPTIONS.map((o) => (
              <li key={o.value}>
                <label className="flex items-baseline gap-2 text-sm">
                  <input
                    type="radio"
                    name="disposition"
                    value={o.value}
                    checked={pickValue === o.value}
                    onChange={() => setPickValue(o.value)}
                    disabled={pending}
                  />
                  <span>{o.label}</span>
                  <span className="text-xs text-[color:var(--color-muted-foreground)]">
                    {o.helper}
                  </span>
                </label>
              </li>
            ))}
          </ul>

          {pickValue === 'declined' && (
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Reason (required) — e.g. cannot satisfy KYC; sanctions watchlist; pricing structure misaligned"
              rows={2}
              disabled={pending}
              className="w-full rounded border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1 text-sm focus:border-[color:var(--color-foreground)] focus:outline-none"
            />
          )}

          <div className="flex justify-end gap-1.5">
            <button
              type="button"
              onClick={() => setOpen(false)}
              disabled={pending}
              className="rounded border border-[color:var(--color-border)] px-2 py-0.5 text-xs hover:border-[color:var(--color-foreground)] disabled:opacity-40"
            >
              Skip
            </button>
            <button
              type="button"
              onClick={submit}
              disabled={pending || (pickValue === 'declined' && reason.trim().length === 0)}
              className="rounded bg-[color:var(--color-foreground)] px-2 py-0.5 text-xs text-[color:var(--color-background)] hover:opacity-90 disabled:opacity-40"
            >
              Save
            </button>
          </div>
        </div>
      )}

      {current && !open && (
        <p className="text-[10px] text-[color:var(--color-muted-foreground)]">
          Last set {formatRelative(current.setAt)}.
        </p>
      )}
    </section>
  );
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function formatRelative(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return iso;
  const days = Math.floor((Date.now() - t) / 86400000);
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}
