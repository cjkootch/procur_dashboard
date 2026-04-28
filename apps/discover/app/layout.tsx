import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { ClerkProvider } from '@clerk/nextjs';
import { Montserrat } from 'next/font/google';
import { SiteHeader } from '../components/site-header';
import { SiteFooter } from '../components/site-footer';
import { AssistantBootstrap } from '../components/assistant-bootstrap';
import { AssistantWidget } from '../components/assistant-widget';
import './globals.css';

const montserrat = Montserrat({
  subsets: ['latin'],
  variable: '--font-montserrat',
  display: 'swap',
});

const DISCOVER_URL = process.env.NEXT_PUBLIC_DISCOVER_URL ?? 'https://discover.procur.app';

export const metadata: Metadata = {
  metadataBase: new URL(DISCOVER_URL),
  title: {
    default: 'Procur Discover — Government tenders across emerging markets',
    template: '%s | Procur',
  },
  description:
    'Search and browse thousands of active government tenders from the Caribbean, Latin America, and Africa.',
  openGraph: {
    type: 'website',
    siteName: 'Procur Discover',
    url: DISCOVER_URL,
  },
  twitter: { card: 'summary_large_image' },
  robots: { index: true, follow: true },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  // ClerkProvider here gives us session-aware components (UserButton,
  // SignedIn/SignedOut) inside the otherwise-public Discover surface.
  // Discover stays browseable while signed-out — middleware enforces
  // nothing; ClerkProvider is purely there to detect the cross-subdomain
  // cookie set by app.procur.app's sign-in flow and surface the user
  // identity in the header.
  return (
    <ClerkProvider>
      <html lang="en" className={montserrat.variable}>
        <body className="flex min-h-screen flex-col">
          <SiteHeader />
          <main className="flex-1">{children}</main>
          <SiteFooter />
          {/* AssistantBootstrap reads any handshake token from the URL
              hash on first paint. AssistantWidget renders the floating
              launcher; it self-gates to the connected/disconnected state
              based on localStorage rather than Clerk session, since
              Discover lives on a different subdomain than the App and
              dev-key Clerk sessions don't share cross-origin. */}
          <AssistantBootstrap />
          <AssistantWidget />
        </body>
      </html>
    </ClerkProvider>
  );
}
