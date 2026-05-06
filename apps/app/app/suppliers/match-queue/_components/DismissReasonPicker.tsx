'use client';

import { useEffect, useRef, useState } from 'react';

const REASONS: Array<{ value: string; label: string }> = [
  { value: 'irrelevant_entity', label: 'Irrelevant entity' },
  { value: 'wrong_segment', label: 'Wrong segment' },
  { value: 'outdated_information', label: 'Outdated information' },
  { value: 'duplicate', label: 'Duplicate of another match' },
  { value: 'other', label: 'Other' },
];

const TIMEOUT_MS = 3000;

/**
 * Pattern 1 dismiss-reason picker per docs/feedback-ui-brief.md §4.3.
 * Renders a small overlay top-right after a dismiss action; auto-
 * dismisses after 3 seconds. Clicking a reason patches the dispatched
 * feedback_event with the reason. The 3-second timeout is critical —
 * it never blocks the user from continuing.
 *
 * Single-instance; the parent (MatchQueueList) renders one of these
 * with the most-recent dismissed event id when present, then nulls
 * the prop on timeout/click.
 */
export function DismissReasonPicker({
  feedbackEventId,
  onDone,
}: {
  feedbackEventId: string;
  onDone: () => void;
}) {
  const [showOther, setShowOther] = useState(false);
  const [otherText, setOtherText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Schedule auto-close on mount; clear on click / unmount.
  useEffect(() => {
    timer.current = setTimeout(() => {
      onDone();
    }, TIMEOUT_MS);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [onDone]);

  const submit = async (reason: string, freeText: string | null) => {
    if (submitting) return;
    setSubmitting(true);
    if (timer.current) clearTimeout(timer.current);
    void fetch(`/api/feedback/dismiss-reason/${feedbackEventId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason, freeText }),
    }).finally(() => onDone());
  };

  return (
    <div className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-background)] p-2 shadow-xl">
      <div className="mb-1 text-[10px] uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
        Why? (optional, 3s)
      </div>
      {showOther ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit('other', otherText.trim() || null);
          }}
          className="flex items-center gap-2"
        >
          <input
            autoFocus
            value={otherText}
            onChange={(e) => setOtherText(e.target.value)}
            placeholder="optional note"
            className="rounded border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-0.5 text-xs focus:border-[color:var(--color-foreground)] focus:outline-none"
          />
          <button
            type="submit"
            disabled={submitting}
            className="rounded bg-[color:var(--color-foreground)] px-2 py-0.5 text-[11px] text-[color:var(--color-background)] disabled:opacity-40"
          >
            Save
          </button>
        </form>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {REASONS.map((r) => (
            <button
              key={r.value}
              type="button"
              disabled={submitting}
              onClick={() => {
                if (r.value === 'other') {
                  if (timer.current) clearTimeout(timer.current);
                  setShowOther(true);
                } else {
                  void submit(r.value, null);
                }
              }}
              className="rounded border border-[color:var(--color-border)] px-2 py-0.5 text-[11px] hover:border-[color:var(--color-foreground)] disabled:opacity-40"
            >
              {r.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
