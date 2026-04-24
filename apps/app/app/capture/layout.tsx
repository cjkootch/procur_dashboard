import Link from 'next/link';
import type { ReactNode } from 'react';
import { UserButton } from '@clerk/nextjs';
import { getCurrentCompany, getCurrentUser } from '@procur/auth';
import { redirect } from 'next/navigation';

export default async function CaptureLayout({ children }: { children: ReactNode }) {
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
          <NavLink href="/capture" label="Dashboard" />
          <NavLink href="/capture/pipeline" label="Pipeline" />
          <NavLink href="/capture/pursuits" label="All pursuits" />
          <NavLink href="/capture/tasks" label="Tasks" />
          <div className="mt-4 px-2 text-xs uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
            Products
          </div>
          <NavLink href="/" label="Overview" />
          <NavLink href="/proposal" label="Proposal" />
          <NavLink href="/pricer" label="Pricer" />
          <NavLink href="/contract" label="Contract" />
          <NavLink href="/past-performance" label="Past performance" />
          <NavLink href="/alerts" label="Alerts" />
          <div className="mt-4 px-2 text-xs uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
            Account
          </div>
          <NavLink href="/billing" label="Billing" />
        </nav>
      </aside>

      <div className="flex-1 flex flex-col">
        <header className="flex items-center justify-between border-b border-[color:var(--color-border)] px-6 py-3">
          <div className="text-sm text-[color:var(--color-muted-foreground)]">Capture</div>
          <UserButton afterSignOutUrl="/sign-in" />
        </header>
        <main className="flex-1 overflow-auto">{children}</main>
      </div>
    </div>
  );
}

function NavLink({
  href,
  label,
  disabled,
}: {
  href: string;
  label: string;
  disabled?: boolean;
}) {
  if (disabled) {
    return (
      <span className="rounded-[var(--radius-sm)] px-2 py-1 text-[color:var(--color-muted-foreground)] opacity-60">
        {label}
      </span>
    );
  }
  return (
    <Link
      href={href}
      className="rounded-[var(--radius-sm)] px-2 py-1 hover:bg-[color:var(--color-background)]"
    >
      {label}
    </Link>
  );
}
