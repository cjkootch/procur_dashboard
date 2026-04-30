'use client';

import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { SidebarNavLink } from './SidebarNavLink';

export type MobileNavGroup = {
  heading?: string;
  items: Array<{ href: string; label: string; external?: boolean }>;
};

/**
 * Mobile-only navigation: a hamburger button (in the header) that opens
 * a slide-in drawer with the same nav structure as the desktop sidebar.
 *
 * The drawer auto-closes on navigation (pathname change), Escape, or
 * backdrop tap. Body scroll is locked while open so the page underneath
 * doesn't scroll behind the drawer.
 *
 * Visible only below the `md:` breakpoint (768px) — at desktop sizes
 * the static <aside> sidebar in AppShell takes over.
 */
export function MobileNav({
  nav,
  companyLabel,
}: {
  nav: MobileNavGroup[];
  companyLabel?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Open navigation"
        className="inline-flex h-9 w-9 items-center justify-center rounded-[var(--radius-sm)] border border-[color:var(--color-border)] hover:bg-[color:var(--color-muted)]/40 md:hidden"
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <line x1="3" y1="6" x2="21" y2="6" />
          <line x1="3" y1="12" x2="21" y2="12" />
          <line x1="3" y1="18" x2="21" y2="18" />
        </svg>
      </button>

      {open && (
        <div className="fixed inset-0 z-[1100] md:hidden" aria-modal="true" role="dialog">
          <button
            type="button"
            aria-label="Close navigation"
            onClick={() => setOpen(false)}
            className="absolute inset-0 bg-black/40"
          />
          <aside className="absolute inset-y-0 left-0 flex w-[min(85vw,300px)] flex-col border-r border-[color:var(--color-border)] bg-[color:var(--color-background)] shadow-xl">
            <div className="flex items-center justify-between border-b border-[color:var(--color-border)] p-3">
              <span className="text-sm font-semibold">Procur</span>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close navigation"
                className="rounded-[var(--radius-sm)] p-1.5 hover:bg-[color:var(--color-muted)]"
              >
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
            {companyLabel && (
              <p className="truncate px-3 pt-2 text-xs text-[color:var(--color-muted-foreground)]">
                {companyLabel}
              </p>
            )}
            <nav className="flex-1 overflow-y-auto px-2 py-3">
              {nav.map((group, i) => (
                <div key={group.heading ?? `g-${i}`} className={i === 0 ? '' : 'mt-4'}>
                  {group.heading && (
                    <div className="mb-1 px-2 text-[10px] font-semibold uppercase tracking-wider text-[color:var(--color-muted-foreground)]">
                      {group.heading}
                    </div>
                  )}
                  <div className="flex flex-col gap-0.5">
                    {group.items.map((item) => (
                      <SidebarNavLink
                        key={item.href}
                        href={item.href}
                        label={item.label}
                        external={item.external}
                      />
                    ))}
                  </div>
                </div>
              ))}
            </nav>
          </aside>
        </div>
      )}
    </>
  );
}
