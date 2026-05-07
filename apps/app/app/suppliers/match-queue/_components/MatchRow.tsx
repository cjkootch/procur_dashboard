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
  /** When parent MatchQueueList focuses this row for keyboard
      shortcuts. Renders an outline ring. Optional — non-list usage
      (single-row preview) treats undefined as not-focused. */
  isFocused?: boolean;
  /** 200ms color-flash tone when the parent records a feedback action.
      'positive'=green, 'negative'=red, 'mute'=blue, 'pin'=amber. */
  flash?: 'positive' | 'negative' | 'mute' | 'pin' | null;
  /** Parent-controlled feedback dispatch — when wired, the row
      shows the 4-button feedback strip (👍 👎 🔇 📌). */
  onFeedback?: (tone: 'positive' | 'negative' | 'pin') => void;
  onMute?: () => void;
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

  const qualifyAsLead = () => {
    setPushError(null);
    setOptimisticStatus('qualified');
    startTransition(async () => {
      const res = await fetch(`/api/match-queue/${props.id}/qualify-as-lead`, {
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
      const body = (await res.json()) as { leadUrl?: string };
      if (body.leadUrl && typeof window !== 'undefined') {
        window.open(body.leadUrl, '_blank', 'noopener,noreferrer');
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

  // Visual states layered on the row: focused-ring, flash-overlay,
  // hover. Flash overlay uses a brief tone-tinted background that
  // fades via the opacity transition the parent unsets after 200ms.
  const focusRing = props.isFocused
    ? 'ring-1 ring-inset ring-[color:var(--color-foreground)]/40'
    : '';
  const flashBg =
    props.flash === 'positive'
      ? 'bg-emerald-500/15'
      : props.flash === 'negative'
      ? 'bg-red-500/15'
      : props.flash === 'mute'
      ? 'bg-blue-500/15'
      : props.flash === 'pin'
      ? 'bg-amber-500/15'
      : '';

  return (
    <li
      // Mobile (<lg): stacked layout — chips line, entity + rationale,
      // observed-at + actions row that wraps. The dense 6-column grid
      // ships on lg+ where horizontal real estate is fine.
      className={`group relative flex flex-col gap-2 border-b border-[color:var(--color-border)]/60 px-3 py-3 transition hover:bg-[color:var(--color-muted)]/30 lg:grid lg:grid-cols-[3px_56px_88px_minmax(0,1fr)_72px_auto] lg:items-center lg:gap-3 lg:py-2.5 lg:pl-0 lg:pr-2 ${focusRing} ${flashBg}`}
    >
      <span className={`absolute left-0 top-1.5 bottom-1.5 w-[3px] rounded-r ${style.strip}`} />

      {/* Chips row — score + signal pill + observed-at on mobile;
          lg+ splits these into separate grid cells. */}
      <span aria-hidden="true" className="hidden lg:block" />

      <div className="flex items-center gap-2 lg:contents">
        <span className={scoreChipClass(props.score)} title="match score (0-9.99)">
          {props.score.toFixed(1)}
        </span>

        <span
          className={`inline-flex items-center justify-center rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${style.pillBg} ${style.pillFg}`}
        >
          {style.label}
        </span>

        <span className="ml-auto text-[11px] tabular-nums text-[color:var(--color-muted-foreground)] lg:hidden">
          {formatObserved(props.observedAt)}
        </span>
      </div>

      <div className="min-w-0">
        <div className="flex flex-wrap items-baseline gap-1.5">
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
          <p className="mt-0.5 text-xs text-[color:var(--color-muted-foreground)] lg:line-clamp-1">
            {rationale}
          </p>
        )}
        {pushError && (
          <p className="mt-0.5 text-[11px] text-red-700">{pushError}</p>
        )}
      </div>

      <span className="hidden text-right text-[11px] tabular-nums text-[color:var(--color-muted-foreground)] lg:inline">
        {formatObserved(props.observedAt)}
      </span>

      <div className="flex flex-wrap items-center gap-1">
        {/* Pattern 1 feedback strip — shown when the parent
            MatchQueueList is wired in. Each button corresponds to
            the keyboard shortcut. Title attrs make the binding
            discoverable without a help overlay. Touch targets bumped
            from h-7 to h-8 for thumb-comfort on phones. */}
        {props.onFeedback && (
          <>
            <button
              type="button"
              onClick={() => props.onFeedback?.('positive')}
              title="Relevant — surface more like this  [f]"
              aria-label="Mark as relevant"
              className="inline-flex h-8 min-w-[32px] items-center justify-center rounded-[var(--radius-sm)] border border-transparent px-1.5 text-[16px] leading-none hover:border-emerald-500/50 hover:text-emerald-700"
            >
              👍
            </button>
            <button
              type="button"
              onClick={() => props.onFeedback?.('negative')}
              title="Not relevant — surface less like this  [d]"
              aria-label="Mark as not relevant"
              className="inline-flex h-8 min-w-[32px] items-center justify-center rounded-[var(--radius-sm)] border border-transparent px-1.5 text-[16px] leading-none hover:border-red-500/50 hover:text-red-700"
            >
              👎
            </button>
            <button
              type="button"
              onClick={() => props.onMute?.()}
              title="Mute this signal type for this entity  [m]"
              aria-label="Mute"
              className="inline-flex h-8 min-w-[32px] items-center justify-center rounded-[var(--radius-sm)] border border-transparent px-1.5 text-[16px] leading-none hover:border-blue-500/50 hover:text-blue-700"
            >
              🔇
            </button>
            <button
              type="button"
              onClick={() => props.onFeedback?.('pin')}
              title="Pin for follow-up  [p]"
              aria-label="Pin"
              className="inline-flex h-8 min-w-[32px] items-center justify-center rounded-[var(--radius-sm)] border border-transparent px-1.5 text-[16px] leading-none hover:border-amber-500/50 hover:text-amber-700"
            >
              📌
            </button>
            <span className="mx-1 h-4 w-px bg-[color:var(--color-border)]" />
          </>
        )}
        <button
          type="button"
          disabled={pending}
          onClick={qualifyAsLead}
          title="Qualify this signal as a lead with full match-queue context attached"
          className="inline-flex h-8 items-center rounded-[var(--radius-sm)] bg-[color:var(--color-foreground)] px-3 text-xs font-medium text-[color:var(--color-background)] hover:opacity-90 disabled:opacity-40"
        >
          Qualify
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={() => update('actioned')}
          title="Mark as handled"
          className="inline-flex h-8 items-center rounded-[var(--radius-sm)] border border-[color:var(--color-border)] px-2.5 text-xs hover:border-[color:var(--color-foreground)] disabled:opacity-40"
        >
          Actioned
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={() => update('dismissed')}
          title="Hide this row"
          aria-label="Dismiss"
          className="inline-flex h-8 min-w-[32px] items-center justify-center rounded-[var(--radius-sm)] border border-transparent px-1.5 text-[18px] leading-none text-[color:var(--color-muted-foreground)] hover:border-[color:var(--color-border)] hover:text-[color:var(--color-foreground)] disabled:opacity-40"
        >
          ×
        </button>
      </div>
    </li>
  );
}
