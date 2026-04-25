import Link from 'next/link';
import type { ReactNode } from 'react';
import { UserButton } from '@clerk/nextjs';
import { requireAdmin } from '../../lib/require-admin';

const NAV: Array<{ href: string; label: string }> = [
  { href: '/', label: 'Overview' },
  { href: '/tenants', label: 'Tenants' },
  { href: '/usage', label: 'AI usage' },
  { href: '/audit', label: 'Audit log' },
  { href: '/webhooks', label: 'Webhooks' },
];

/**
 * Admin shell. Single sidebar + header — no per-tenant context, since
 * everything in this app is cross-tenant. Calls requireAdmin() at the
 * top so unauthorized users (signed in but not on the allow-list) get
 * a clear 500 with the offending email in logs.
 */
export async function AdminShell({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  const admin = await requireAdmin();
  return (
    <div className="flex min-h-screen bg-[color:var(--color-background)]">
      <aside className="flex w-56 shrink-0 flex-col border-r border-[color:var(--color-border)] bg-[color:var(--color-muted)]/20">
        <div className="border-b border-[color:var(--color-border)] px-4 py-4">
          <p className="text-sm font-semibold">Procur Admin</p>
          <p className="mt-0.5 text-[10px] text-[color:var(--color-muted-foreground)]">
            Internal tooling
          </p>
        </div>
        <nav className="flex-1 p-2 text-sm">
          {NAV.map((n) => (
            <Link
              key={n.href}
              href={n.href}
              className="block rounded-[var(--radius-sm)] px-2 py-1.5 hover:bg-[color:var(--color-muted)]/40"
            >
              {n.label}
            </Link>
          ))}
        </nav>
        <div className="border-t border-[color:var(--color-border)] p-3 text-[10px] text-[color:var(--color-muted-foreground)]">
          Signed in as {admin.email}
        </div>
      </aside>

      <div className="flex flex-1 flex-col">
        <header className="flex items-center justify-between border-b border-[color:var(--color-border)] bg-[color:var(--color-background)] px-6 py-3">
          <h1 className="text-sm font-semibold">{title}</h1>
          <UserButton afterSignOutUrl="/sign-in" />
        </header>
        <main className="flex-1 overflow-auto">{children}</main>
      </div>
    </div>
  );
}
