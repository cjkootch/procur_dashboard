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

type SignalStyle = {
  label: string;
  // Tailwind class for the row's left accent strip + pill background.
  strip: string;
  pillBg: string;
  pillFg: string;
};

const SIGNAL_STYLE: Record<string, SignalStyle> = {
  distress_event: {
    label: 'distress',
    strip: 'bg-red-500',
    pillBg: 'bg-red-500/10',
    pillFg: 'text-red-700',
  },
  velocity_drop: {
    label: 'velocity',
    strip: 'bg-amber-500',
    pillBg: 'bg-amber-500/10',
    pillFg: 'text-amber-800',
  },
  new_award: {
    label: 'new award',
    strip: 'bg-emerald-500',
    pillBg: 'bg-emerald-500/10',
    pillFg: 'text-emerald-700',
  },
};

const FALLBACK_STYLE: SignalStyle = {
  label: 'signal',
  strip: 'bg-[color:var(--color-border)]',
  pillBg: 'bg-[color:var(--color-muted)]/40',
  pillFg: 'text-[color:var(--color-muted-foreground)]',
};

/**
 * Score chip class — color-graded so a glance at the column tells
 * the trader which leads matter most. Thresholds match the scoring
 * job: 8.0 = high relevance distress, 6-8 = medium, <6 = low.
 */
function scoreChipClass(score: number): string {
  const base =
    'inline-flex h-7 w-12 items-center justify-center rounded-md text-[13px] font-semibold tabular-nums';
  if (score >= 8) return `${base} bg-red-500/15 text-red-700`;
  if (score >= 6) return `${base} bg-amber-500/15 text-amber-800`;
  return `${base} bg-[color:var(--color-muted)]/60 text-[color:var(--color-muted-foreground)]`;
}

/**
 * Format an ISO date as "Apr 30" / "Apr 30 '24" — the year is only
 * shown when the row is not from the current year, since scrolling
 * a column of full ISO dates wastes attention.
 */
function formatObserved(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const month = d.toLocaleString('en-US', { month: 'short' });
  const day = d.getUTCDate();
  const yr = d.getUTCFullYear();
  const thisYr = new Date().getUTCFullYear();
  return yr === thisYr ? `${month} ${day}` : `${month} ${day} '${String(yr).slice(2)}`;
}

/**
 * If the rationale is the legacy redundant template
 * ("event_type · Entity (XX) · 2026-04-30"), suppress it so the row
 * doesn't duplicate every other column. New rationales (LLM summary
 * for distress, "X% drop" for velocity, "diesel award · $1.2M" for
 * new_award) have signal in them naturally.
 */
function useableRationale(
  rationale: string,
  signalKind: string,
  entityName: string,
  observedAt: string,
): string | null {
  const trimmed = rationale.trim();
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase();
  // Drop if it's just kind · name · date — exact match against the
  // template the legacy SQL produced.
  if (
    lower.startsWith(signalKind.toLowerCase()) &&
    lower.includes(entityName.toLowerCase()) &&
    lower.includes(observedAt)
  ) {
    return null;
  }
  return trimmed;
}

export function MatchRow(props: MatchRowProps) {
  const [optimisticStatus, setOptimisticStatus] = useState(props.status);
  const [pushError, setPushError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  const style = SIGNAL_STYLE[props.signalType] ?? FALLBACK_STYLE;

  const update = (status: 'dismissed' | 'actioned') => {
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

  const pushToVex = () => {
    setPushError(null);
    setOptimisticStatus('pushed-to-vex');
    startTransition(async () => {
      const res = await fetch(`/api/match-queue/${props.id}/push-to-vex`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          message?: string;
          error?: string;
        };
        setOptimisticStatus('open');
        setPushError(body.message ?? body.error ?? `push failed (${res.status})`);
        return;
      }
      const body = (await res.json()) as { vexRecordUrl?: string };
      if (body.vexRecordUrl && typeof window !== 'undefined') {
        window.open(body.vexRecordUrl, '_blank', 'noopener,noreferrer');
      }
      router.refresh();
    });
  };

  if (optimisticStatus !== 'open') {
    return null;
  }

  const rationale = useableRationale(
    props.rationale,
    props.signalKind,
    props.sourceEntityName,
    props.observedAt,
  );

  return (
    <li
      className={`group relative grid grid-cols-[3px_56px_88px_minmax(0,1fr)_72px_auto] items-center gap-3 border-b border-[color:var(--color-border)]/60 py-2.5 pl-0 pr-2 transition hover:bg-[color:var(--color-muted)]/30`}
    >
      <span className={`absolute left-0 top-1.5 bottom-1.5 w-[3px] rounded-r ${style.strip}`} />

      <span aria-hidden="true" />

      <span className={scoreChipClass(props.score)} title="match score (0-9.99)">
        {props.score.toFixed(1)}
      </span>

      <span
        className={`inline-flex items-center justify-center rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${style.pillBg} ${style.pillFg}`}
      >
        {style.label}
      </span>

      <div className="min-w-0">
        <div className="flex items-baseline gap-1.5">
          {props.entityProfileSlug ? (
            <Link
              href={`/entities/${props.entityProfileSlug}`}
              className="truncate text-sm font-medium hover:underline"
            >
              {props.sourceEntityName}
            </Link>
          ) : (
            <span className="truncate text-sm font-medium">{props.sourceEntityName}</span>
          )}
          {props.sourceEntityCountry && (
            <span className="shrink-0 text-[11px] tabular-nums text-[color:var(--color-muted-foreground)]">
              {props.sourceEntityCountry}
            </span>
          )}
          {props.categoryTags.length > 0 && (
            <span className="shrink-0 text-[11px] text-[color:var(--color-muted-foreground)]">
              · {props.categoryTags.slice(0, 2).join(', ')}
            </span>
          )}
        </div>
        {rationale && (
          <p className="mt-0.5 line-clamp-1 text-xs text-[color:var(--color-muted-foreground)]">
            {rationale}
          </p>
        )}
        {pushError && (
          <p className="mt-0.5 text-[11px] text-red-700">{pushError}</p>
        )}
      </div>

      <span className="text-right text-[11px] tabular-nums text-[color:var(--color-muted-foreground)]">
        {formatObserved(props.observedAt)}
      </span>

      <div className="flex items-center gap-1">
        <button
          type="button"
          disabled={pending}
          onClick={pushToVex}
          title="Push this lead to vex CRM with full procur commercial context"
          className="rounded-[var(--radius-sm)] bg-[color:var(--color-foreground)] px-2.5 py-1 text-[11px] font-medium text-[color:var(--color-background)] hover:opacity-90 disabled:opacity-40"
        >
          Push to vex
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={() => update('actioned')}
          title="Mark as handled outside vex"
          className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] px-2 py-1 text-[11px] hover:border-[color:var(--color-foreground)] disabled:opacity-40"
        >
          Actioned
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={() => update('dismissed')}
          title="Hide this row"
          aria-label="Dismiss"
          className="rounded-[var(--radius-sm)] border border-transparent px-1.5 py-1 text-[14px] leading-none text-[color:var(--color-muted-foreground)] hover:border-[color:var(--color-border)] hover:text-[color:var(--color-foreground)] disabled:opacity-40"
        >
          ×
        </button>
      </div>
    </li>
  );
}
