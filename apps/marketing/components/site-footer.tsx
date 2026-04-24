import Image from 'next/image';
import Link from 'next/link';

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'https://app.procur.app';
const DISCOVER_URL = process.env.NEXT_PUBLIC_DISCOVER_URL ?? 'https://discover.procur.app';

export function SiteFooter() {
  return (
    <footer className="mt-32 border-t border-[color:var(--color-border)]">
      <div className="mx-auto grid max-w-6xl gap-10 px-6 py-12 text-sm md:grid-cols-4">
        <div>
          <Image
            src="/brand/procur-logo-dark.svg"
            alt="Procur"
            width={96}
            height={40}
            className="h-9 w-auto"
          />
          <p className="mt-3 text-[color:var(--color-muted-foreground)]">
            Win government contracts in emerging markets.
          </p>
        </div>
        <div>
          <p className="font-medium">Product</p>
          <ul className="mt-2 space-y-1.5 text-[color:var(--color-muted-foreground)]">
            <li>
              <a className="hover:underline" href={DISCOVER_URL}>
                Discover
              </a>
            </li>
            <li>
              <a className="hover:underline" href={APP_URL}>
                Capture · Proposal · Pricer · Contract
              </a>
            </li>
            <li>
              <Link className="hover:underline" href="/pricing">
                Pricing
              </Link>
            </li>
          </ul>
        </div>
        <div>
          <p className="font-medium">Coverage</p>
          <ul className="mt-2 space-y-1.5 text-[color:var(--color-muted-foreground)]">
            <li>Caribbean</li>
            <li>Latin America</li>
            <li>Africa</li>
          </ul>
        </div>
        <div>
          <p className="font-medium">Company</p>
          <ul className="mt-2 space-y-1.5 text-[color:var(--color-muted-foreground)]">
            <li>
              <a className="hover:underline" href="mailto:hello@procur.app">
                hello@procur.app
              </a>
            </li>
          </ul>
        </div>
      </div>
      <div className="border-t border-[color:var(--color-border)]">
        <p className="mx-auto max-w-6xl px-6 py-4 text-xs text-[color:var(--color-muted-foreground)]">
          © {new Date().getFullYear()} Procur. All rights reserved.
        </p>
      </div>
    </footer>
  );
}
