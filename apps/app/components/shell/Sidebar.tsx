'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { usePathname } from 'next/navigation';
import { SidebarNavLink } from './SidebarNavLink';
import { QuickCreate } from './QuickCreate';
import type { NavIconName } from './nav-icons';

const COLLAPSED_KEY = 'procur.nav.collapsedGroups.v1';

export type SidebarNavGroup = {
  /** Stable id for localStorage; null for top items that aren't a
      collapsible group (e.g. the home/Brief row). */
  id: string | null;
  /** Group heading; null when items render directly without a group. */
  heading: string | null;
  items: Array<{
    href: string;
    label: string;
    iconName: NavIconName;
    external?: boolean;
  }>;
};

export type SidebarCompany = {
  name: string;
  planTier: string;
} | null;

function loadCollapsed(): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(COLLAPSED_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === 'string') : [];
  } catch {
    return [];
  }
}

function saveCollapsed(ids: string[]): void {
  try {
    window.localStorage.setItem(COLLAPSED_KEY, JSON.stringify(ids));
  } catch {
    /* localStorage unavailable (private browsing) — collapse state is ephemeral. */
  }
}

/**
 * Inner sidebar content — logo, company info, QuickCreate, collapsible
 * nav groups, footer hint. Used by both the desktop <aside> sidebar
 * and the mobile slide-in drawer; positioning lives in the wrappers.
 */
function SidebarContent({
  nav,
  company,
  onNavigate,
}: {
  nav: SidebarNavGroup[];
  company: SidebarCompany;
  /** Fired when a nav link is clicked — used by mobile drawer to
      auto-close on navigation. */
  onNavigate?: () => void;
}) {
  const [collapsed, setCollapsed] = useState<string[]>([]);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    setCollapsed(loadCollapsed());
    setHydrated(true);
  }, []);

  const toggleGroup = (id: string) => {
    setCollapsed((prev) => {
      const next = prev.includes(id) ? prev.filter((g) => g !== id) : [...prev, id];
      saveCollapsed(next);
      return next;
    });
  };

  return (
    <>
      <div className="p-3">
        <Link href="/" aria-label="Procur home" className="block" onClick={onNavigate}>
          <Image
            src="/brand/procur-logo-dark.svg"
            alt="Procur"
            width={96}
            height={40}
            priority
            className="h-10 w-auto"
          />
        </Link>
        {company && (
          <p className="mt-2 truncate text-xs text-[color:var(--color-muted-foreground)]">
            {company.name} · {company.planTier}
          </p>
        )}
        <div className="mt-3">
          <QuickCreate />
        </div>
      </div>
      <nav className="flex-1 overflow-y-auto px-2 pb-4">
        {nav.map((group, i) => {
          // Pre-hydration: render every group expanded so SSR markup
          // matches initial client render. After hydration, apply the
          // saved collapsed state.
          const isCollapsed = group.id != null && hydrated && collapsed.includes(group.id);
          const isCollapsible = group.id != null && group.heading != null;
          return (
            <div key={group.id ?? `g-${i}`} className={i === 0 ? '' : 'mt-4'}>
              {isCollapsible && (
                <button
                  type="button"
                  onClick={() => toggleGroup(group.id as string)}
                  aria-expanded={!isCollapsed}
                  className="mb-1 flex w-full items-center justify-between rounded-[var(--radius-sm)] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-foreground)]"
                >
                  <span>{group.heading}</span>
                  <svg
                    width="10"
                    height="10"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className={`transition-transform ${isCollapsed ? '' : 'rotate-90'}`}
                    aria-hidden="true"
                  >
                    <polyline points="9 6 15 12 9 18" />
                  </svg>
                </button>
              )}
              {!isCollapsed && (
                <div className="flex flex-col gap-0.5">
                  {group.items.map((item) => (
                    <SidebarNavLink
                      key={item.href}
                      href={item.href}
                      label={item.label}
                      iconName={item.iconName}
                      external={item.external}
                      onNavigate={onNavigate}
                    />
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </nav>
      <div className="border-t border-[color:var(--color-border)] p-3 text-[10px] text-[color:var(--color-muted-foreground)]">
        Press{' '}
        <kbd className="rounded border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-1">
          ⌘K
        </kbd>{' '}
        to open the assistant
      </div>
    </>
  );
}

/**
 * Desktop sidebar — fixed-width column, hidden below md breakpoint.
 * Width is driven by the `--shell-sidebar-width` token so any future
 * shell-width change happens in one place.
 */
export function Sidebar({
  nav,
  company,
}: {
  nav: SidebarNavGroup[];
  company: SidebarCompany;
}) {
  return (
    <aside
      className="hidden shrink-0 flex-col border-r border-[color:var(--color-border)] bg-[color:var(--color-muted)]/40 md:flex"
      style={{ width: 'var(--shell-sidebar-width)' }}
    >
      <SidebarContent nav={nav} company={company} />
    </aside>
  );
}

/**
 * Mobile sidebar — hamburger button that opens a slide-in drawer with
 * the same nav structure. Auto-closes on navigation, Escape, or
 * backdrop tap. Body scroll is locked while open.
 */
export function MobileSidebar({
  nav,
  company,
}: {
  nav: SidebarNavGroup[];
  company: SidebarCompany;
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
        <div className="fixed inset-0 z-[1100] md:hidden" role="dialog" aria-modal="true">
          <button
            type="button"
            aria-label="Close navigation"
            onClick={() => setOpen(false)}
            className="absolute inset-0 bg-black/40"
          />
          <aside className="absolute inset-y-0 left-0 flex w-[min(85vw,300px)] flex-col border-r border-[color:var(--color-border)] bg-[color:var(--color-background)] shadow-xl">
            <SidebarContent nav={nav} company={company} onNavigate={() => setOpen(false)} />
          </aside>
        </div>
      )}
    </>
  );
}
