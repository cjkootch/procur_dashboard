import Image from 'next/image';
import Link from 'next/link';

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
          <Link className="hover:underline" href="/opportunities">
            Opportunities
          </Link>
          <Link className="hover:underline" href="/jurisdictions">
            Jurisdictions
          </Link>
          <a
            className="rounded-[var(--radius-md)] bg-[color:var(--color-foreground)] px-3 py-1.5 text-sm font-medium text-[color:var(--color-background)] hover:opacity-90"
            href={process.env.NEXT_PUBLIC_APP_URL ?? 'https://app.procur.app'}
          >
            Sign in
          </a>
        </nav>
      </div>
    </header>
  );
}
