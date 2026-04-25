'use client';

import * as Sentry from '@sentry/nextjs';
import Link from 'next/link';
import { useEffect } from 'react';

/**
 * Shared error fallback for Next 15 `error.tsx` boundaries.
 *
 * - Captures the error to Sentry once on mount (only on client; the
 *   server-side render is the one Next.js triggered the boundary for).
 * - Shows a friendly fallback with the digest id (Next attaches one
 *   automatically for production-redacted errors) so support can
 *   correlate to the Sentry trace.
 * - "Try again" calls Next's reset() to re-run the segment.
 * - "Go home" link as the secondary out.
 *
 * Optional `surface` prop colors the heading copy so a contract page
 * error and a proposal page error don't read identically.
 */
export function ErrorBoundary({
  error,
  reset,
  surface,
}: {
  error: Error & { digest?: string };
  reset: () => void;
  surface?: string;
}) {
  useEffect(() => {
    Sentry.captureException(error, {
      tags: { surface: surface ?? 'unknown' },
      extra: { digest: error.digest ?? null },
    });
  }, [error, surface]);

  return (
    <div className="mx-auto max-w-xl px-6 py-16 text-center">
      <h2 className="text-lg font-semibold">Something went wrong</h2>
      <p className="mt-2 text-sm text-[color:var(--color-muted-foreground)]">
        {surface
          ? `We hit an unexpected error loading ${surface}.`
          : 'We hit an unexpected error loading this page.'}
        {' '}Our team has been notified.
      </p>
      {error.digest && (
        <p className="mt-2 text-[11px] text-[color:var(--color-muted-foreground)]">
          Reference id:{' '}
          <span className="font-mono select-all">{error.digest}</span>
        </p>
      )}
      <div className="mt-6 flex items-center justify-center gap-2">
        <button
          type="button"
          onClick={() => reset()}
          className="rounded-[var(--radius-md)] bg-[color:var(--color-foreground)] px-4 py-1.5 text-sm font-medium text-[color:var(--color-background)]"
        >
          Try again
        </button>
        <Link
          href="/"
          className="rounded-[var(--radius-md)] border border-[color:var(--color-border)] px-4 py-1.5 text-sm hover:bg-[color:var(--color-muted)]/40"
        >
          Go home
        </Link>
      </div>
    </div>
  );
}
