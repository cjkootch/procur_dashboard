'use client';

import * as Sentry from '@sentry/nextjs';
import NextError from 'next/error';
import { useEffect } from 'react';

/**
 * Catches errors thrown in the root layout / providers. Per-route
 * error.tsx boundaries handle leaf failures, but a crash in
 * RootLayout, ClerkProvider, PostHogProvider etc. would otherwise
 * fall through with no Sentry event. Required by @sentry/nextjs
 * for App Router projects.
 */
export default function GlobalError({
  error,
}: {
  error: Error & { digest?: string };
}) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <html lang="en">
      <body>
        <NextError statusCode={0} />
      </body>
    </html>
  );
}
