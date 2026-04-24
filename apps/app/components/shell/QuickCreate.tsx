'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';

/**
 * Quick-create menu modeled on GovDash's top-of-sidebar button.
 * Opens a small dropdown of the most common create actions. Closes on
 * outside click and Escape.
 */
const ITEMS: Array<{ href: string; label: string; hint: string }> = [
  { href: '/capture/new', label: 'New pursuit', hint: 'Track an opportunity you want to bid on' },
  { href: '/contract/new', label: 'New contract', hint: 'Log a signed or awarded contract' },
  { href: '/library/new', label: 'Library entry', hint: 'Capability statement, team bio, boilerplate' },
  { href: '/past-performance/new', label: 'Past performance', hint: 'Reference project for future bids' },
  { href: '/alerts/new', label: 'Alert profile', hint: 'Get notified of matching tenders' },
];

export function QuickCreate() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between rounded-[var(--radius-md)] bg-[color:var(--color-foreground)] px-3 py-2 text-sm font-medium text-[color:var(--color-background)]"
      >
        <span>Quick Create</span>
        <span className="text-xs opacity-60">{open ? '▴' : '▾'}</span>
      </button>
      {open && (
        <div className="absolute left-0 right-0 top-full z-20 mt-1 rounded-[var(--radius-md)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] p-1 shadow-lg">
          {ITEMS.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              onClick={() => setOpen(false)}
              className="block rounded-[var(--radius-sm)] px-2 py-1.5 text-xs hover:bg-[color:var(--color-muted)]/60"
            >
              <div className="font-medium text-[color:var(--color-foreground)]">{item.label}</div>
              <div className="text-[color:var(--color-muted-foreground)]">{item.hint}</div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
