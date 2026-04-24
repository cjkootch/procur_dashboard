import Image from 'next/image';
import Link from 'next/link';

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'https://app.procur.app';
const DISCOVER_URL = process.env.NEXT_PUBLIC_DISCOVER_URL ?? 'https://discover.procur.app';

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-30 border-b border-[color:var(--color-border)] bg-[color:var(--color-background)]/90 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
        <Link href="/" aria-label="Procur home" className="flex items-center">
          <Image
            src="/brand/procur-logo-dark.svg"
            alt="Procur"
            width={96}
            height={40}
            priority
            className="h-7 w-auto"
          />
        </Link>
        <nav className="flex items-center gap-6 text-sm">
          <Link className="hover:underline" href="/pricing">
            Pricing
          </Link>
          <a className="hover:underline" href={DISCOVER_URL}>
            Browse tenders
          </a>
          <a
            className="rounded-[var(--radius-md)] bg-[color:var(--color-foreground)] px-3 py-1.5 font-medium text-[color:var(--color-background)] hover:opacity-90"
            href={APP_URL}
          >
            Sign in
          </a>
        </nav>
      </div>
    </header>
  );
}
