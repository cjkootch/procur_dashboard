'use client';

import { useState, useTransition } from 'react';

/**
 * Push-to-vex button for the entity profile page header.
 *
 * Mirrors the match-queue Push-to-vex pattern: client-side click
 * POSTs to /api/entities/[slug]/push-to-vex, opens the returned vex
 * record URL in a new tab on success, and surfaces errors inline.
 *
 * Auth + the actual outbound call live server-side. This is a thin
 * UI shell.
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
      const body = (await res.json()) as { vexRecordUrl?: string };
      if (body.vexRecordUrl) {
        setPushedUrl(body.vexRecordUrl);
        if (typeof window !== 'undefined') {
          window.open(body.vexRecordUrl, '_blank', 'noopener,noreferrer');
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
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/brand/vex-icon-on-light.svg"
          alt=""
          aria-hidden
          className="h-3.5 w-3.5"
        />
        ✓ Open in vex →
      </a>
    );
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        disabled={pending}
        onClick={onClick}
        title="Forward this counterparty to vex CRM with full procur commercial context"
        className="inline-flex items-center gap-1.5 rounded-[var(--radius-sm)] border border-[color:var(--color-foreground)] bg-[color:var(--color-foreground)] px-3 py-1 text-xs font-medium text-[color:var(--color-background)] hover:opacity-90 disabled:opacity-40"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/brand/vex-icon-on-dark.svg"
          alt=""
          aria-hidden
          className="h-3.5 w-3.5"
        />
        {pending ? 'Pushing…' : 'Push to vex'}
      </button>
      {error && <span className="text-[10px] text-red-700">{error}</span>}
    </div>
  );
}
