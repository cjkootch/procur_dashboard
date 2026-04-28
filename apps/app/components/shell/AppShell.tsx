import Link from 'next/link';
import Image from 'next/image';
import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';
import { UserButton } from '@clerk/nextjs';
import { getCurrentCompany, getCurrentUser } from '@procur/auth';
import { NotificationsBell } from './NotificationsBell';
import { QuickCreate } from './QuickCreate';
import { SidebarNavLink } from './SidebarNavLink';

type NavGroup = {
  heading?: string;
  items: Array<{ href: string; label: string; external?: boolean }>;
};

/**
 * Navigation reorganised around a commodity-trading workflow rather than
 * the broader govcon-shop module set:
 *
 *   1. find        — Discover (public), Reverse search, Rolodex
 *   2. intelligence — Market intelligence, Insights
 *   3. deals        — Pipeline, Pricer, Contracts
 *   4. tools        — Assistant, Alerts
 *   5. account      — Company profile, Billing
 *
 * Hidden because they're proposal-shop heavy and not part of the active
 * trading workflow (the underlying pages still exist and route via direct
 * URL — only the nav surface is trimmed): /proposal, /past-performance,
 * /library, /search.
 *
 * If the platform later adds multi-tenant company tiers / workflows, this
 * should switch to a per-company / per-tier nav config.
 */
const NAV: NavGroup[] = [
  {
    items: [{ href: '/', label: 'Home' }],
  },
  {
    heading: 'Find',
    items: [
      { href: 'https://discover.procur.app', label: 'Discover', external: true },
      { href: '/suppliers/reverse-search', label: 'Reverse search' },
      { href: '/suppliers/known-entities', label: 'Rolodex' },
    ],
  },
  {
    heading: 'Intelligence',
    items: [
      { href: '/suppliers/intelligence', label: 'Market intelligence' },
      { href: '/insights', label: 'My pipeline' },
    ],
  },
  {
    heading: 'Deals',
    items: [
      { href: '/capture', label: 'Pipeline' },
      { href: '/pricer', label: 'Pricer' },
      { href: '/contract', label: 'Contracts' },
    ],
  },
  {
    heading: 'Tools',
    items: [
      { href: '/assistant', label: 'Assistant' },
      { href: '/alerts', label: 'Alerts' },
    ],
  },
  {
    heading: 'Account',
    items: [
      { href: '/settings', label: 'Company profile' },
      { href: '/billing', label: 'Billing' },
    ],
  },
];

/**
 * The shared authenticated-product shell. Every module layout should wrap
 * its children in <AppShell title="..."> instead of duplicating the
 * sidebar. Pages themselves remain in charge of their own content.
 *
 * `title` renders in the top-left of the header, matching GovDash's
 * breadcrumb-style "Capture / Proposal / Contract" label.
 */
export async function AppShell({
  children,
  title,
}: {
  children: ReactNode;
  title: string;
}) {
  const user = await getCurrentUser();
  if (!user) redirect('/sign-in');
  const company = await getCurrentCompany();

  return (
    <div className="flex min-h-screen">
      <aside className="flex w-60 shrink-0 flex-col border-r border-[color:var(--color-border)] bg-[color:var(--color-muted)]/40">
        <div className="p-3">
          <Link href="/" aria-label="Procur home" className="block">
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
          {NAV.map((group, i) => (
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
        <div className="border-t border-[color:var(--color-border)] p-3 text-[10px] text-[color:var(--color-muted-foreground)]">
          Press <kbd className="rounded border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-1">⌘K</kbd> to ask the assistant
        </div>
      </aside>

      <div className="flex flex-1 flex-col">
        <header className="flex items-center justify-between border-b border-[color:var(--color-border)] bg-[color:var(--color-background)] px-6 py-3">
          <div className="text-sm text-[color:var(--color-muted-foreground)]">{title}</div>
          <div className="flex items-center gap-3 text-xs">
            <a
              href="https://docs.procur.app"
              target="_blank"
              rel="noopener noreferrer"
              className="text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-foreground)]"
            >
              Get help
            </a>
            <NotificationsBell />
            <UserButton afterSignOutUrl="/sign-in" />
          </div>
        </header>
        <main className="flex-1 overflow-auto">{children}</main>
      </div>
    </div>
  );
}
