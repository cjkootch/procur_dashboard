'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

export type MatchRowProps = {
  id: string;
  signalType: 'distress_event' | 'velocity_drop' | 'new_award' | string;
  signalKind: string;
  sourceEntityName: string;
  sourceEntityCountry: string | null;
  categoryTags: string[];
  observedAt: string;
  score: number;
  rationale: string;
  status: string;
  entityProfileSlug: string | null;
};

const SIGNAL_BADGE: Record<string, { label: string; cls: string }> = {
  distress_event: {
    label: 'distress',
    cls: 'border-red-500/40 bg-red-500/10 text-red-700',
  },
  velocity_drop: {
    label: 'velocity',
    cls: 'border-amber-500/40 bg-amber-500/10 text-amber-800',
  },
  new_award: {
    label: 'new award',
    cls: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700',
  },
};

export function MatchRow(props: MatchRowProps) {
  const [optimisticStatus, setOptimisticStatus] = useState(props.status);
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  const badge =
    SIGNAL_BADGE[props.signalType] ?? {
      label: props.signalType,
      cls: 'border-[color:var(--color-border)] bg-[color:var(--color-muted)]/30 text-[color:var(--color-muted-foreground)]',
    };

  const update = (status: 'dismissed' | 'pushed-to-vex' | 'actioned') => {
    setOptimisticStatus(status);
    startTransition(async () => {
      await fetch(`/api/match-queue/${props.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      });
      router.refresh();
    });
  };

  if (optimisticStatus !== 'open') {
    return null;
  }

  return (
    <li className="grid grid-cols-[64px_120px_1fr_auto] items-baseline gap-3 border-b border-[color:var(--color-border)]/50 py-2 text-xs">
      <span
        className="rounded-[var(--radius-sm)] border px-1.5 py-0.5 text-center text-[10px] font-semibold tabular-nums"
        title="match score"
      >
        {props.score.toFixed(1)}
      </span>
      <span className={`rounded-full border px-2 py-0.5 text-center text-[10px] font-medium uppercase tracking-wide ${badge.cls}`}>
        {badge.label}
      </span>
      <div>
        {props.entityProfileSlug ? (
          <Link
            href={`/entities/${props.entityProfileSlug}`}
            className="font-medium hover:underline"
          >
            {props.sourceEntityName}
          </Link>
        ) : (
          <span className="font-medium">{props.sourceEntityName}</span>
        )}
        {props.sourceEntityCountry && (
          <span className="ml-1 text-[10px] text-[color:var(--color-muted-foreground)]">
            ({props.sourceEntityCountry})
          </span>
        )}
        <span className="ml-2 text-[color:var(--color-muted-foreground)]">{props.rationale}</span>
        <span className="ml-2 text-[10px] text-[color:var(--color-muted-foreground)]">{props.observedAt}</span>
      </div>
      <div className="flex items-center gap-1">
        <button
          type="button"
          disabled={pending}
          onClick={() => update('pushed-to-vex')}
          title="Mark this lead as pushed to vex (use chat to actually push)"
          className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] px-2 py-0.5 text-[10px] hover:border-[color:var(--color-foreground)] disabled:opacity-40"
        >
          Push to vex
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={() => update('actioned')}
          className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] px-2 py-0.5 text-[10px] hover:border-[color:var(--color-foreground)] disabled:opacity-40"
        >
          Actioned
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={() => update('dismissed')}
          className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] px-2 py-0.5 text-[10px] text-[color:var(--color-muted-foreground)] hover:border-[color:var(--color-foreground)] disabled:opacity-40"
        >
          Dismiss
        </button>
      </div>
    </li>
  );
}
