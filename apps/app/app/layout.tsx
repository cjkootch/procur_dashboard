import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { Montserrat } from 'next/font/google';
import { ClerkProvider } from '@clerk/nextjs';
import { PostHogProvider } from '@procur/analytics/client';
import { AssistantDrawerMount } from '../components/assistant/AssistantDrawerMount';
import './globals.css';

// The authenticated app is 100% user-dependent — nothing should be
// statically prerendered. This also lets the build succeed without
// Clerk credentials present (e.g. in CI).
export const dynamic = 'force-dynamic';

const montserrat = Montserrat({
  subsets: ['latin'],
  variable: '--font-montserrat',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Procur App',
  description: 'Capture, pursue, and win government contracts.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <ClerkProvider>
      <html lang="en" className={montserrat.variable}>
        <body>
          <PostHogProvider
            apiKey={process.env.NEXT_PUBLIC_POSTHOG_KEY}
            apiHost={process.env.NEXT_PUBLIC_POSTHOG_HOST}
          >
            {children}
            <AssistantDrawerMount />
          </PostHogProvider>
        </body>
      </html>
    </ClerkProvider>
  );
}
