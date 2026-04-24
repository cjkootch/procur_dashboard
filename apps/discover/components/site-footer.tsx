import Image from 'next/image';
import Link from 'next/link';

export function SiteFooter() {
  return (
    <footer className="mt-24 border-t border-[color:var(--color-border)]">
      <div className="mx-auto grid max-w-6xl gap-8 px-6 py-10 text-sm md:grid-cols-4">
        <div>
          <Image
            src="/brand/procur-logo-dark.svg"
            alt="Procur"
            width={96}
            height={40}
            className="h-9 w-auto"
          />
          <p className="mt-2 text-[color:var(--color-muted-foreground)]">
            Win government contracts in emerging markets.
          </p>
        </div>
        <div>
          <p className="font-medium">Product</p>
          <ul className="mt-2 space-y-1 text-[color:var(--color-muted-foreground)]">
            <li>
              <Link className="hover:underline" href="/opportunities">
                Browse tenders
              </Link>
            </li>
            <li>
              <Link className="hover:underline" href="/jurisdictions">
                Jurisdictions
              </Link>
            </li>
            <li>
              <a className="hover:underline" href="https://procur.app">
                Procur Pro
              </a>
            </li>
          </ul>
        </div>
        <div>
          <p className="font-medium">Coverage</p>
          <ul className="mt-2 space-y-1 text-[color:var(--color-muted-foreground)]">
            <li>Caribbean</li>
            <li>Latin America</li>
            <li>Africa</li>
          </ul>
        </div>
        <div>
          <p className="font-medium">Company</p>
          <ul className="mt-2 space-y-1 text-[color:var(--color-muted-foreground)]">
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
