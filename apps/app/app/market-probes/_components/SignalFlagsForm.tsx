'use client';

import { useState } from 'react';
import { setTargetSignalsAction } from '../actions';
import { PROBE_SIGNAL_KINDS } from '@procur/catalog';

/**
 * Per-target signal flags form. Renders the canonical signal taxonomy
 * (PROBE_SIGNAL_KINDS) as checkboxes; on save, serializes the merged
 * map to JSON and submits via setTargetSignalsAction.
 *
 * Client component because checkbox state would otherwise round-trip
 * to the server on every toggle. Form bundles all flags into a single
 * `signals` JSON field.
 */
export function SignalFlagsForm({
  probeId,
  targetId,
  current,
}: {
  probeId: string;
  targetId: string;
  current: Record<string, boolean>;
}) {
  const [state, setState] = useState<Record<string, boolean>>(current);

  return (
    <form
      action={setTargetSignalsAction}
      className="mt-2 grid gap-1.5 rounded-[var(--radius-sm)] border border-dashed border-[color:var(--color-border)] p-2 text-xs"
    >
      <input type="hidden" name="probeId" value={probeId} />
      <input type="hidden" name="targetId" value={targetId} />
      <input type="hidden" name="signals" value={JSON.stringify(state)} />
      <div className="grid grid-cols-2 gap-1 md:grid-cols-3">
        {PROBE_SIGNAL_KINDS.map((s) => (
          <label key={s} className="flex items-center gap-1.5 cursor-pointer">
            <input
              type="checkbox"
              checked={state[s] === true}
              onChange={(e) =>
                setState((prev) => ({ ...prev, [s]: e.target.checked }))
              }
            />
            <span>{s.replace(/_/g, ' ')}</span>
          </label>
        ))}
      </div>
      <button
        type="submit"
        className="self-start rounded-[var(--radius-md)] border border-[color:var(--color-border)] px-3 py-1 text-xs font-medium hover:bg-[color:var(--color-muted)]/40"
      >
        Save signals
      </button>
    </form>
  );
}
