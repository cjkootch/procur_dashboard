'use client';

import { useState } from 'react';
import { recordTargetFeedbackAction } from '../actions';

/**
 * Per-target feedback chip strip with an optional shared note input.
 *
 * Lifted to a client component so a single note string can be
 * threaded into whichever chip the operator clicks next — server-
 * rendered chips couldn't share state cleanly. The note input stays
 * empty by default; ignoring it leaves the chip click as a one-click
 * action exactly like before.
 *
 * Selected chips render with a foreground-fill background + ✓ prefix
 * so the operator can see which feedback is already on this target
 * (driven by feedback_events rows passed in via `selectedLabels`).
 *
 * Labels arrive as a prop (rather than imported from @procur/catalog)
 * so this client component doesn't pull the catalog barrel's
 * server-only modules into the client bundle. Same pattern as
 * SignalFlagsForm post-#610.
 */
interface Props {
  probeId: string;
  targetId: string;
  labels: readonly string[];
  selectedLabels: readonly string[];
}

export function TargetFeedbackChips({
  probeId,
  targetId,
  labels,
  selectedLabels,
}: Props) {
  const [note, setNote] = useState('');
  const selectedSet = new Set(selectedLabels);

  return (
    <div className="mt-2 grid gap-1.5">
      <input
        type="text"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="optional reason (saved with next chip click)"
        maxLength={400}
        className="w-full rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1 text-[10px] placeholder:text-[color:var(--color-muted-foreground)]"
      />
      <div className="flex flex-wrap items-center gap-1.5">
        {labels.map((label) => {
          const isSelected = selectedSet.has(label);
          return (
            <form
              key={label}
              action={async (formData: FormData) => {
                if (note.trim().length > 0) {
                  formData.append('note', note.trim());
                }
                await recordTargetFeedbackAction(formData);
                setNote('');
              }}
              className="inline"
            >
              <input type="hidden" name="probeId" value={probeId} />
              <input type="hidden" name="targetId" value={targetId} />
              <input type="hidden" name="label" value={label} />
              <button
                type="submit"
                className={
                  isSelected
                    ? 'rounded-full border border-[color:var(--color-foreground)] bg-[color:var(--color-foreground)] px-2 py-0.5 text-[10px] font-medium text-[color:var(--color-background)]'
                    : 'rounded-full border border-[color:var(--color-border)] px-2 py-0.5 text-[10px] hover:bg-[color:var(--color-muted)]/40'
                }
                title={
                  isSelected
                    ? `Recorded: ${label.replace(/_/g, ' ')}`
                    : `Record feedback: ${label.replace(/_/g, ' ')}`
                }
              >
                {isSelected ? '✓ ' : ''}
                {label.replace(/_/g, ' ')}
              </button>
            </form>
          );
        })}
      </div>
    </div>
  );
}
