'use client';

import { useState } from 'react';

/**
 * Tiny client-side wrapper that renders two `<tr>` rows — the main
 * row and an optional expanded row — with a click-to-toggle chevron
 * on the main row. Lets the parent table stay flat while surfacing
 * long-form content (description, requirements) without a modal.
 *
 * `colSpan` must match the number of columns in the parent table so
 * the expanded row stretches cleanly.
 */
export function LcatRowExpander({
  colSpan,
  renderSummary,
  renderExpanded,
}: {
  colSpan: number;
  renderSummary: (args: { open: boolean; toggle: () => void }) => React.ReactNode;
  renderExpanded: () => React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const toggle = () => setOpen((v) => !v);
  return (
    <>
      {renderSummary({ open, toggle })}
      {open && (
        <tr className="bg-[color:var(--color-muted)]/20">
          <td colSpan={colSpan} className="px-4 py-3">
            {renderExpanded()}
          </td>
        </tr>
      )}
    </>
  );
}

/** Chevron rendered in the summary row's title cell. */
export function ExpanderChevron({ open }: { open: boolean }) {
  return (
    <span
      aria-hidden
      className={`inline-block text-[10px] text-[color:var(--color-muted-foreground)] transition-transform ${
        open ? 'rotate-90' : ''
      }`}
    >
      ▸
    </span>
  );
}
