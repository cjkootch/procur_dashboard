'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { MatchRow, type MatchRowProps } from './MatchRow';
import { DismissReasonPicker } from './DismissReasonPicker';

/**
 * Match-queue list wrapper per docs/feedback-ui-brief.md §4.3.
 *
 * Owns:
 *   - focused-row index (for keyboard nav + auto-advance)
 *   - global keyboard handlers (j/k navigate, f favorite, d dismiss,
 *     m mute, p pin)
 *   - "row just got feedback" highlight state for the 200ms color
 *     flash that confirms capture without modal interruption
 *   - hidden-row tracking (so dismissed/actioned/feedback'd rows
 *     drop out of the visible list optimistically)
 *   - dismiss-reason picker — shown for 3s after a negative
 *     dispatch, attaches reason via PATCH if user clicks
 *
 * Children — MatchRow components — stay focused on their own
 * rendering. They receive callbacks that funnel back here.
 */
export function MatchQueueList({ rows }: { rows: MatchRowProps[] }) {
  const [focusedIdx, setFocusedIdx] = useState(0);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [flashed, setFlashed] = useState<{ id: string; tone: 'positive' | 'negative' | 'mute' | 'pin' } | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Most-recent dismiss event id, set when user dispatches a
      negative for the 3-second reason-picker window. */
  const [pendingDismissId, setPendingDismissId] = useState<string | null>(null);

  // Recompute the visible list whenever hidden changes; the focused
  // index references the visible row order, not the original.
  const visible = rows.filter((r) => !hidden.has(r.id));

  const flash = useCallback((id: string, tone: 'positive' | 'negative' | 'mute' | 'pin') => {
    setFlashed({ id, tone });
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlashed(null), 220);
  }, []);

  const advance = useCallback(() => {
    setFocusedIdx((i) => Math.min(i, Math.max(0, visible.length - 2)));
  }, [visible.length]);

  const handleFeedback = useCallback(
    (rowId: string, tone: 'positive' | 'negative' | 'pin') => {
      flash(rowId, tone);
      // Pin keeps the row visible (it's still active, just flagged); positive +
      // negative remove from queue immediately per brief §4.3 auto-advance flow.
      if (tone !== 'pin') {
        setHidden((prev) => {
          const next = new Set(prev);
          next.add(rowId);
          return next;
        });
        advance();
      }
    },
    [flash, advance],
  );

  const handleMute = useCallback(
    (rowId: string) => {
      flash(rowId, 'mute');
      setHidden((prev) => {
        const next = new Set(prev);
        next.add(rowId);
        return next;
      });
      advance();
    },
    [flash, advance],
  );

  // Global keyboard handlers — scoped to the queue page only via the
  // event-target check (don't fire when the user is typing in a search
  // box, filter dropdown, etc.).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const focused = visible[focusedIdx];
      switch (e.key) {
        case 'j':
          e.preventDefault();
          setFocusedIdx((i) => Math.min(visible.length - 1, i + 1));
          break;
        case 'k':
          e.preventDefault();
          setFocusedIdx((i) => Math.max(0, i - 1));
          break;
        case 'f':
          if (!focused) return;
          e.preventDefault();
          void dispatchFeedback(focused, 'positive');
          handleFeedback(focused.id, 'positive');
          break;
        case 'd':
          if (!focused) return;
          e.preventDefault();
          void dispatchFeedback(focused, 'negative').then((id) => {
            if (id) setPendingDismissId(id);
          });
          handleFeedback(focused.id, 'negative');
          break;
        case 'm':
          if (!focused) return;
          e.preventDefault();
          dispatchMute(focused);
          handleMute(focused.id);
          break;
        case 'p':
          if (!focused) return;
          e.preventDefault();
          void dispatchFeedback(focused, 'pin');
          handleFeedback(focused.id, 'pin');
          break;
        default:
          return;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [visible, focusedIdx, handleFeedback, handleMute]);

  if (visible.length === 0) {
    return (
      <p className="px-4 py-6 text-center text-sm text-[color:var(--color-muted-foreground)]">
        No more rows. Reload to see new matches.
      </p>
    );
  }

  return (
    <ul className="border-t border-[color:var(--color-border)]/40">
      {visible.map((r, idx) => (
        <MatchRow
          key={r.id}
          {...r}
          isFocused={idx === focusedIdx}
          flash={flashed?.id === r.id ? flashed.tone : null}
          onFeedback={(tone) => {
            void dispatchFeedback(r, tone).then((id) => {
              if (tone === 'negative' && id) setPendingDismissId(id);
            });
            handleFeedback(r.id, tone);
          }}
          onMute={() => {
            dispatchMute(r);
            handleMute(r.id);
          }}
        />
      ))}
      {pendingDismissId && (
        <DismissReasonPicker
          feedbackEventId={pendingDismissId}
          onDone={() => setPendingDismissId(null)}
        />
      )}
      <li className="px-3 py-2 text-[10px] text-[color:var(--color-muted-foreground)]">
        Keyboard: <kbd>j</kbd>/<kbd>k</kbd> navigate · <kbd>f</kbd> favorite · <kbd>d</kbd> dismiss · <kbd>m</kbd> mute · <kbd>p</kbd> pin
      </li>
    </ul>
  );
}

// ─── Server dispatch helpers ──────────────────────────────────────

/** Returns the inserted feedback_event id when the POST succeeds —
 *  used by the negative-dispatch path to wire up the dismiss-reason
 *  picker. Errors are swallowed (best-effort capture). */
async function dispatchFeedback(
  row: MatchRowProps,
  tone: 'positive' | 'negative' | 'pin',
): Promise<string | null> {
  try {
    const res = await fetch('/api/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        feedbackKind: 'match_quality',
        targetType: 'match',
        targetId: row.id,
        targetSecondaryId: row.entityProfileSlug ?? null,
        sentiment: tone,
        payload: {
          match_score: row.score,
          signal_type: row.signalType,
          signal_kind: row.signalKind,
        },
        context: typeof window !== 'undefined' ? { page: window.location.pathname } : null,
      }),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { id?: string };
    return body.id ?? null;
  } catch {
    return null;
  }
}

function dispatchMute(row: MatchRowProps) {
  if (!row.entityProfileSlug) return;
  void fetch('/api/feedback/mute', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      entitySlug: row.entityProfileSlug,
      signalType: row.signalType,
      signalSource: null,
      context: typeof window !== 'undefined' ? { page: window.location.pathname } : null,
    }),
  }).catch(() => undefined);
}
