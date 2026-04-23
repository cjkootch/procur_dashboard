import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { SiteHeader } from '../components/site-header';
import { SiteFooter } from '../components/site-footer';
import './globals.css';

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
  return (
    <html lang="en">
      <body className="flex min-h-screen flex-col">
        <SiteHeader />
        <main className="flex-1">{children}</main>
        <SiteFooter />
      </body>
    </html>
  );
}
