import Image from 'next/image';
import Link from 'next/link';
import type { ReactNode } from 'react';

const HIGHLIGHTS = [
  {
    title: 'Discover',
    body: 'Tenders from Caribbean, Latin America & Africa, normalized into one feed.',
  },
  {
    title: 'Capture',
    body: 'Pursuit pipeline with capture questions, gate reviews, teaming & capabilities.',
  },
  {
    title: 'Propose',
    body: 'Compliance shred, AI-drafted sections, and review — purpose-built for emerging markets.',
  },
];

/**
 * Two-pane auth shell used by /sign-in and /sign-up. Brand panel on
 * the left (navy background, logo, tagline, feature highlights); the
 * Clerk component hosts on the right.
 *
 * Layout breakpoints:
 *   - lg (≥1024px): two-column 1fr/1fr split, brand on the left.
 *   - md (768-1023px, tablets): two-column with a narrower brand
 *     column so the form fits next to it without scrolling. Highlights
 *     are hidden to keep the brand pane compact.
 *   - <md (phones): brand pane collapses to a slim header strip so the
 *     auth form stays above the fold.
 */
export function AuthShell({
  title,
  subtitle,
  altLink,
  children,
}: {
  title: string;
  subtitle: string;
  altLink: { href: string; label: string; cta: string };
  children: ReactNode;
}) {
  return (
    <main className="grid min-h-screen md:grid-cols-[18rem_1fr] lg:grid-cols-[1fr_1fr]">
      {/* Brand panel */}
      <aside className="relative flex flex-col justify-between overflow-hidden bg-[#000734] px-6 py-6 text-white md:px-8 md:py-10 lg:px-12 lg:py-14">
        {/* Soft radial glow + diagonal accent — aesthetic, no dependencies */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 opacity-60"
          style={{
            backgroundImage:
              'radial-gradient(60rem 30rem at 80% -10%, rgba(99,102,241,0.18), transparent 60%), radial-gradient(50rem 40rem at -10% 110%, rgba(56,189,248,0.12), transparent 60%)',
          }}
        />
        <div className="relative">
          <Link href="https://procur.app" className="inline-flex items-center" aria-label="Procur home">
            <Image
              src="/brand/procur-logo-light.svg"
              alt="Procur"
              width={140}
              height={56}
              priority
              className="h-8 w-auto md:h-10"
            />
          </Link>
          <p className="mt-6 max-w-md text-xl font-semibold leading-tight md:mt-8 md:text-2xl lg:text-3xl">
            Win government contracts in emerging markets.
          </p>
          {/* Tagline + highlights only render on md+; phones get just the
              logo strip + headline so the form stays above the fold. */}
          <p className="mt-3 hidden max-w-md text-sm leading-relaxed text-white/70 md:block">
            One workspace from tender discovery to contract delivery — for teams
            bidding in the Caribbean, Latin America, and Africa.
          </p>

          <ul className="mt-10 hidden max-w-md space-y-5 lg:block">
            {HIGHLIGHTS.map((h) => (
              <li key={h.title} className="flex gap-3">
                <span
                  aria-hidden
                  className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-white/70"
                />
                <div>
                  <p className="text-sm font-semibold">{h.title}</p>
                  <p className="text-xs text-white/65">{h.body}</p>
                </div>
              </li>
            ))}
          </ul>
        </div>

        <div className="relative mt-6 hidden text-xs text-white/50 md:block">
          © {new Date().getFullYear()} Procur · Built for developing-market procurement.
        </div>
      </aside>

      {/* Auth panel */}
      <section className="flex flex-col justify-center px-6 py-10 lg:px-12">
        <div className="mx-auto w-full max-w-md">
          <header className="mb-6">
            <h1 className="text-2xl font-semibold text-[color:var(--color-foreground)]">
              {title}
            </h1>
            <p className="mt-1 text-sm text-[color:var(--color-muted-foreground)]">
              {subtitle}
            </p>
          </header>

          {children}

          <p className="mt-6 text-center text-xs text-[color:var(--color-muted-foreground)]">
            {altLink.cta}{' '}
            <Link
              href={altLink.href}
              className="font-medium text-[color:var(--color-foreground)] underline underline-offset-2"
            >
              {altLink.label}
            </Link>
          </p>
        </div>
      </section>
    </main>
  );
}

/**
 * Shared Clerk theme appearance — keeps the form chromeless so our outer
 * shell provides the visual frame. Buttons match the foreground/background
 * tokens so light/dark themes both look correct without overrides.
 */
export const clerkAppearance = {
  elements: {
    rootBox: 'w-full',
    card:
      'shadow-none border-none bg-transparent p-0 w-full',
    headerTitle: 'hidden',
    headerSubtitle: 'hidden',
    socialButtonsBlockButton:
      'border-[color:var(--color-border)] text-[color:var(--color-foreground)] hover:bg-[color:var(--color-muted)]/40',
    formButtonPrimary:
      'bg-[#000734] hover:bg-[#000734]/90 text-white text-sm font-medium normal-case',
    footer: 'hidden',
    formFieldInput:
      'border-[color:var(--color-border)] bg-[color:var(--color-background)] text-sm',
    dividerLine: 'bg-[color:var(--color-border)]',
    dividerText: 'text-[color:var(--color-muted-foreground)]',
    formFieldLabel: 'text-xs uppercase tracking-wider text-[color:var(--color-muted-foreground)]',
    identityPreviewEditButton: 'text-[#000734]',
    formResendCodeLink: 'text-[#000734]',
  },
  variables: {
    colorPrimary: '#000734',
    colorTextOnPrimaryBackground: '#ffffff',
    borderRadius: '0.5rem',
    fontFamily: 'var(--font-montserrat), ui-sans-serif, system-ui',
  },
} as const;
