import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';
import { UserButton } from '@clerk/nextjs';
import { getCurrentCompany, getCurrentUser } from '@procur/auth';
import { NotificationsBell } from './NotificationsBell';
import { LevelChip } from '../gamification/LevelChip';
import { NotificationsLiveLayer } from './NotificationsLiveLayer';
import { getNotificationPollState } from '../../lib/notification-queries';
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
  // Watch — things demanding attention. Approvals/signals/inbox land
  // first (vex execution-layer surfaces), then the legacy procur
  // surfaces (match queue / alerts / pinned / friction) sit below.
  // Friction sits here (not under Settings) — it's an operator-feedback
  // queue, not a configuration knob.
  {
    id: 'watch',
    heading: 'Watch',
    items: [
      { href: '/approvals', label: 'Approvals', iconName: 'check-shield' },
      { href: '/signals', label: 'Signals', iconName: 'lightning' },
      { href: '/inbox', label: 'Inbox', iconName: 'inbox' },
      { href: '/messages', label: 'Messages', iconName: 'chat-bubble' },
      { href: '/suppliers/match-queue', label: 'Match queue', iconName: 'lightning' },
      { href: '/follow-ups', label: 'Follow-ups', iconName: 'clock' },
      { href: '/pinned', label: 'Pinned', iconName: 'clock' },
      { href: '/alerts', label: 'Alerts', iconName: 'bell' },
      { href: '/quests', label: 'Quests', iconName: 'sparkles' },
      { href: '/achievements', label: 'Achievements', iconName: 'sparkles' },
      { href: '/friction', label: 'Friction log', iconName: 'inbox' },
    ],
  },
  // Pipeline — active work. Leads + Deals are the new vex-execution
  // entries; the rest is procur's pre-existing pursuit surface.
  {
    id: 'pipeline',
    heading: 'Pipeline',
    items: [
      { href: '/insights', label: 'My pipeline', iconName: 'kanban' },
      { href: '/leads', label: 'Leads', iconName: 'people' },
      { href: '/deals', label: 'Deals', iconName: 'document-text' },
      { href: '/capture', label: 'Capture', iconName: 'kanban' },
      { href: '/contract', label: 'Contracts', iconName: 'document-text' },
      { href: '/deal-structures', label: 'Deal structures', iconName: 'map' },
      { href: '/pricer', label: 'Pricer', iconName: 'calculator' },
      { href: '/retrospectives', label: 'Retrospectives', iconName: 'clock' },
    ],
  },
  // Outreach — outbound execution + agent visibility (vex-merged).
  {
    id: 'outreach',
    heading: 'Outreach',
    items: [
      { href: '/campaigns', label: 'Campaigns', iconName: 'megaphone' },
      { href: '/market-probes', label: 'Market Probes', iconName: 'compass' },
      { href: '/market-atlas', label: 'Market Atlas', iconName: 'map' },
      { href: '/market-playbooks', label: 'Market Playbooks', iconName: 'document-text' },
      { href: '/calls', label: 'Calls & messaging', iconName: 'phone' },
      { href: '/agent-runs', label: 'Agent runs', iconName: 'sparkles' },
    ],
  },
  {
    id: 'counterparties',
    heading: 'Counterparties',
    items: [
      { href: '/suppliers/known-entities', label: 'Rolodex', iconName: 'address-book' },
      { href: '/relationships/heat-map', label: 'Heat-map', iconName: 'map' },
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
  // Settings — purely configuration (company profile + email/templates
  // + notification prefs + integrations + billing). Previously had
  // the friction log mixed in; that's a queue, not a config knob, so
  // it moved up to Watch.
  {
    id: 'settings',
    heading: 'Settings',
    items: [
      { href: '/settings', label: 'Company profile', iconName: 'settings' },
      { href: '/settings/email', label: 'Email defaults', iconName: 'inbox' },
      { href: '/settings/templates', label: 'Templates', iconName: 'chat-bubble' },
      { href: '/settings/notifications', label: 'Notification settings', iconName: 'bell' },
      { href: '/settings/integrations/mcp', label: 'Integrations', iconName: 'shield-check' },
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
  // Seed the live polling layer with the most recent notification's
  // createdAt so the first poll only surfaces things that arrived
  // after this page render (avoids spamming a toast for every unread
  // row from days ago).
  const pollState = await getNotificationPollState(user.id);

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
            <LevelChip />
            <NotificationsBell />
            <UserButton afterSignOutUrl="/sign-in" />
          </div>
        </header>
        <main className="flex-1 overflow-auto">
          {title && <PageHeader title={title} />}
          {children}
        </main>
      </div>
      <NotificationsLiveLayer initialLatest={pollState.latestCreatedAt} />
    </div>
  );
}
