import type { ReactNode } from 'react';
import Link from 'next/link';

/**
 * Public docs layout. Deliberately bare — no AppShell, no auth gate,
 * no sidebar nav. The pages under /docs/ are operator + indie-
 * developer reference content; AppShell is for the authenticated
 * product surface.
 *
 * Middleware (apps/app/middleware.ts) explicitly whitelists
 * `/docs/(.*)` so Clerk doesn't redirect anonymous traffic away.
 */
export default function DocsLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-[color:var(--color-background)] text-[color:var(--color-foreground)]">
      <header className="border-b border-[color:var(--color-border)] px-6 py-4">
        <div className="mx-auto flex max-w-4xl items-center justify-between">
          <Link href="/" className="text-sm font-semibold tracking-tight">
            Procur
          </Link>
          <nav className="flex items-center gap-4 text-xs text-[color:var(--color-muted-foreground)]">
            <Link href="/docs/mcp" className="hover:text-[color:var(--color-foreground)]">
              MCP
            </Link>
            <Link href="/sign-in" className="hover:text-[color:var(--color-foreground)]">
              Sign in
            </Link>
          </nav>
        </div>
      </header>
      <main>{children}</main>
      <footer className="mt-12 border-t border-[color:var(--color-border)] px-6 py-6">
        <div className="mx-auto max-w-4xl text-[10px] text-[color:var(--color-muted-foreground)]">
          Procur Inc. &middot;{' '}
          <a
            href="https://app.procur.app"
            className="underline hover:text-[color:var(--color-foreground)]"
          >
            app.procur.app
          </a>
        </div>
      </footer>
    </div>
  );
}
