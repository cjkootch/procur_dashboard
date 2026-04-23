import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { ClerkProvider } from '@clerk/nextjs';
import { PostHogProvider } from '@procur/analytics/client';
import './globals.css';

export const metadata: Metadata = {
  title: 'Procur App',
  description: 'Capture, pursue, and win government contracts.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <ClerkProvider>
      <html lang="en">
        <body>
          <PostHogProvider
            apiKey={process.env.NEXT_PUBLIC_POSTHOG_KEY}
            apiHost={process.env.NEXT_PUBLIC_POSTHOG_HOST}
          >
            {children}
          </PostHogProvider>
        </body>
      </html>
    </ClerkProvider>
  );
}
