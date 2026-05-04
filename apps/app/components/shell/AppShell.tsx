import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';
import { UserButton } from '@clerk/nextjs';
import { getCurrentCompany, getCurrentUser } from '@procur/auth';
import { NotificationsBell } from './NotificationsBell';
import { PageHeader } from './PageHeader';
import { Sidebar, MobileSidebar, type SidebarNavGroup } from './Sidebar';

/**
 * Navigation grouped to mirror vex's structural mental model:
 *
 *   1. Brief / Assistant      — daily-driver entry points
 *   2. Now                    — match queue, alerts (immediate work)
 *   3. Pipeline               — capture, contracts, pricer
 *   4. Counterparties         — rolodex, reverse-search, discover, competitors
 *   5. Intelligence           — market intel, vessels
 *   6. Account                — company profile, billing
 *
 * Hidden because they're proposal-shop heavy and not part of the active
 * trading workflow (the underlying pages still exist and route via direct
 * URL — only the nav surface is trimmed): /proposal, /past-performance,
 * /library, /search.
 */
const NAV: SidebarNavGroup[] = [
  {
    id: null,
    heading: null,
    items: [
      { href: '/', label: 'Brief', iconName: 'sparkles' },
      { href: '/assistant', label: 'Assistant', iconName: 'chat-bubble' },
    ],
  },
  {
    id: 'now',
    heading: 'Now',
    items: [
      { href: '/suppliers/match-queue', label: 'Match queue', iconName: 'lightning' },
      { href: '/alerts', label: 'Alerts', iconName: 'bell' },
    ],
  },
  {
    id: 'pipeline',
    heading: 'Pipeline',
    items: [
      { href: '/insights', label: 'My pipeline', iconName: 'kanban' },
      { href: '/capture', label: 'Capture', iconName: 'kanban' },
      { href: '/contract', label: 'Contracts', iconName: 'document-text' },
      { href: '/pricer', label: 'Pricer', iconName: 'calculator' },
    ],
  },
  {
    id: 'counterparties',
    heading: 'Counterparties',
    items: [
      { href: '/suppliers/known-entities', label: 'Rolodex', iconName: 'address-book' },
      { href: '/suppliers/reverse-search', label: 'Reverse search', iconName: 'search' },
      {
        href: 'https://discover.procur.app',
        label: 'Discover',
        iconName: 'compass',
        external: true,
      },
      { href: '/suppliers/competitors', label: 'Competitors', iconName: 'building-bank' },
    ],
  },
  {
    id: 'intelligence',
    heading: 'Intelligence',
    items: [
      { href: '/suppliers/intelligence', label: 'Market intelligence', iconName: 'globe' },
      { href: '/crudes', label: 'Crudes', iconName: 'droplet' },
      { href: '/suppliers/vessels', label: 'Vessels', iconName: 'anchor' },
    ],
  },
  {
    id: 'account',
    heading: 'Account',
    items: [
      { href: '/settings', label: 'Company profile', iconName: 'settings' },
      { href: '/billing', label: 'Billing', iconName: 'credit-card' },
    ],
  },
];

/**
 * The shared authenticated-product shell. Pages wrap their content in
 * <AppShell title="Page name">.
 *
 * If `title` is supplied, AppShell auto-renders a <PageHeader> at the
 * top of <main> — backwards-compatible with every existing caller. To
 * opt into a custom header (breadcrumb, primary actions, tabs), pass
 * `title=""` or `undefined` and render your own <PageHeader> inside
 * the page.
 */
export async function AppShell({
  children,
  title,
}: {
  children: ReactNode;
  /** Title for the auto-rendered PageHeader. Pass undefined or empty
      string to opt out and render a custom header inside the page. */
  title?: string;
}) {
  const user = await getCurrentUser();
  if (!user) redirect('/sign-in');
  const company = await getCurrentCompany();
  const sidebarCompany = company
    ? { name: company.name, planTier: company.planTier }
    : null;

  return (
    <div className="flex min-h-screen">
      <Sidebar nav={NAV} company={sidebarCompany} />

      <div className="flex min-w-0 flex-1 flex-col">
        <header
          className="flex items-center justify-between gap-3 border-b border-[color:var(--color-border)] bg-[color:var(--color-background)] px-4 md:px-6"
          style={{ height: 'var(--shell-topbar-height)' }}
        >
          <MobileSidebar nav={NAV} company={sidebarCompany} />
          <div className="ml-auto flex items-center gap-3 text-xs">
            <a
              href="https://docs.procur.app"
              target="_blank"
              rel="noopener noreferrer"
              className="hidden text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-foreground)] sm:inline"
            >
              Get help
            </a>
            <NotificationsBell />
            <UserButton afterSignOutUrl="/sign-in" />
          </div>
        </header>
        <main className="flex-1 overflow-auto">
          {title && <PageHeader title={title} />}
          {children}
        </main>
      </div>
    </div>
  );
}
