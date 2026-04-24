import Link from 'next/link';
import type { ReactNode } from 'react';
import { UserButton } from '@clerk/nextjs';
import { getCurrentCompany, getCurrentUser } from '@procur/auth';
import { redirect } from 'next/navigation';

export default async function AlertsLayout({ children }: { children: ReactNode }) {
  const user = await getCurrentUser();
  if (!user) redirect('/sign-in');
  const company = await getCurrentCompany();

  return (
    <div className="flex min-h-screen">
      <aside className="w-56 border-r border-[color:var(--color-border)] bg-[color:var(--color-muted)]/40">
        <div className="p-4">
          <Link href="/" className="block text-lg font-semibold tracking-tight">
            Procur
          </Link>
          {company && (
            <p className="mt-1 text-xs text-[color:var(--color-muted-foreground)]">
              {company.name} · {company.planTier}
            </p>
          )}
        </div>
        <nav className="flex flex-col gap-1 px-2 text-sm">
          <div className="px-2 text-xs uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
            Alerts
          </div>
          <Link
            href="/alerts"
            className="rounded-[var(--radius-sm)] px-2 py-1 hover:bg-[color:var(--color-background)]"
          >
            All alerts
          </Link>
          <Link
            href="/alerts/new"
            className="rounded-[var(--radius-sm)] px-2 py-1 hover:bg-[color:var(--color-background)]"
          >
            New alert
          </Link>
          <div className="mt-4 px-2 text-xs uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
            Products
          </div>
          <Link href="/capture" className="rounded-[var(--radius-sm)] px-2 py-1 hover:bg-[color:var(--color-background)]">
            Capture
          </Link>
          <Link href="/proposal" className="rounded-[var(--radius-sm)] px-2 py-1 hover:bg-[color:var(--color-background)]">
            Proposal
          </Link>
          <Link href="/pricer" className="rounded-[var(--radius-sm)] px-2 py-1 hover:bg-[color:var(--color-background)]">
            Pricer
          </Link>
          <Link href="/contract" className="rounded-[var(--radius-sm)] px-2 py-1 hover:bg-[color:var(--color-background)]">
            Contract
          </Link>
          <Link href="/past-performance" className="rounded-[var(--radius-sm)] px-2 py-1 hover:bg-[color:var(--color-background)]">
            Past performance
          </Link>
          <Link href="/library" className="rounded-[var(--radius-sm)] px-2 py-1 hover:bg-[color:var(--color-background)]">
            Content library
          </Link>
          <Link href="/insights" className="rounded-[var(--radius-sm)] px-2 py-1 hover:bg-[color:var(--color-background)]">
            Insights
          </Link>
          <div className="mt-4 px-2 text-xs uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
            Account
          </div>
          <Link href="/billing" className="rounded-[var(--radius-sm)] px-2 py-1 hover:bg-[color:var(--color-background)]">
            Billing
          </Link>
        </nav>
      </aside>
      <div className="flex-1 flex flex-col">
        <header className="flex items-center justify-between border-b border-[color:var(--color-border)] px-6 py-3">
          <div className="text-sm text-[color:var(--color-muted-foreground)]">Alerts</div>
          <UserButton afterSignOutUrl="/sign-in" />
        </header>
        <main className="flex-1 overflow-auto">{children}</main>
      </div>
    </div>
  );
}
