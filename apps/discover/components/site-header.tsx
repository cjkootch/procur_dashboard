import Image from 'next/image';
import Link from 'next/link';
import { SignedIn, SignedOut, UserButton } from '@clerk/nextjs';

const HOVER_LINK =
  'hover:underline focus-visible:outline-none focus-visible:underline rounded-sm';
const SIGN_IN_BUTTON =
  'inline-flex items-center justify-center gap-1.5 rounded-[var(--radius-md)] h-9 px-3.5 text-sm font-medium ' +
  'bg-[color:var(--color-foreground)] text-[color:var(--color-background)] hover:opacity-90 ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-foreground)]/30 ' +
  'focus-visible:ring-offset-1 focus-visible:ring-offset-[color:var(--color-background)]';

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'https://app.procur.app';

export function SiteHeader() {
  return (
    <header className="border-b border-[color:var(--color-border)] bg-[color:var(--color-background)]">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
        <Link href="/" aria-label="Procur Discover home" className="flex items-center gap-2">
          <Image
            src="/brand/procur-logo-dark.svg"
            alt="Procur"
            width={96}
            height={40}
            priority
            className="h-9 w-auto"
          />
          <span className="text-sm text-[color:var(--color-muted-foreground)]">Discover</span>
        </Link>
        <nav className="flex items-center gap-6 text-sm">
          <Link className={HOVER_LINK} href="/opportunities">
            Opportunities
          </Link>
          <Link className={HOVER_LINK} href="/jurisdictions">
            Jurisdictions
          </Link>
          {/* Auth-aware right side. Both states render exactly one
              control so the header doesn't reflow during hydration. */}
          <SignedOut>
            <a className={SIGN_IN_BUTTON} href={APP_URL}>
              Sign in
            </a>
          </SignedOut>
          <SignedIn>
            <a
              className={HOVER_LINK + ' text-[color:var(--color-foreground)]'}
              href={APP_URL}
            >
              Open app
            </a>
            <UserButton
              afterSignOutUrl="/"
              appearance={{
                elements: {
                  avatarBox: 'h-8 w-8',
                },
              }}
            />
          </SignedIn>
        </nav>
      </div>
    </header>
  );
}
