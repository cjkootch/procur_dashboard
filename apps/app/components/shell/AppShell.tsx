import Link from 'next/link';
import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';
import { UserButton } from '@clerk/nextjs';
import { getCurrentCompany, getCurrentUser } from '@procur/auth';
import { QuickCreate } from './QuickCreate';
import { SidebarNavLink } from './SidebarNavLink';

type NavGroup = {
  heading?: string;
  items: Array<{ href: string; label: string; external?: boolean }>;
};

/**
 * Navigation structure mirrors GovDash's left rail:
 *   - top group is home / lifecycle overview / Discover (public)
 *   - products group is Capture, Proposal, Pricer, Contract
 *   - data group is the content library and past-performance store
 *   - reports group is Insights, Assistant, Search
 *   - account group is settings and billing
 */
const NAV: NavGroup[] = [
  {
    items: [
      { href: '/', label: 'Home' },
      { href: 'https://discover.procur.app', label: 'Discover', external: true },
    ],
  },
  {
    heading: 'Products',
    items: [
      { href: '/capture', label: 'Capture' },
      { href: '/proposal', label: 'Proposal' },
      { href: '/pricer', label: 'Pricer' },
      { href: '/contract', label: 'Contract' },
    ],
  },
  {
    heading: 'Data',
    items: [
      { href: '/library', label: 'Content library' },
      { href: '/past-performance', label: 'Past performance' },
    ],
  },
  {
    heading: 'Reports',
    items: [
      { href: '/insights', label: 'Insights' },
      { href: '/assistant', label: 'Assistant' },
      { href: '/search', label: 'Search' },
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
          <Link href="/" className="block text-lg font-semibold tracking-tight">
            Procur
          </Link>
          {company && (
            <p className="mt-1 truncate text-xs text-[color:var(--color-muted-foreground)]">
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
            <UserButton afterSignOutUrl="/sign-in" />
          </div>
        </header>
        <main className="flex-1 overflow-auto">{children}</main>
      </div>
    </div>
  );
}
