import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { Montserrat } from 'next/font/google';
import { ClerkProvider } from '@clerk/nextjs';
import './globals.css';

// Internal admin tooling — Clerk-gated, allow-list enforced. Per-page
// requireAdmin() does the second-gate DB check.
export const dynamic = 'force-dynamic';

const montserrat = Montserrat({
  subsets: ['latin'],
  variable: '--font-montserrat',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Procur Admin',
  description: 'Internal administration for the Procur platform.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <ClerkProvider>
      <html lang="en" className={montserrat.variable}>
        <body>{children}</body>
      </html>
    </ClerkProvider>
  );
}
