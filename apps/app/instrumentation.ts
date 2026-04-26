import * as Sentry from '@sentry/nextjs';

export async function register() {
  if (!process.env.SENTRY_DSN) return;
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('./sentry.server.config');
  }
  if (process.env.NEXT_RUNTIME === 'edge') {
    await import('./sentry.edge.config');
  }
}

/**
 * Forwards every server-side request error (Server Components, Route
 * Handlers, Server Actions) to Sentry. Required for @sentry/nextjs
 * >= 8.28.0 — without this hook the Next.js error redaction strips the
 * stack and Sentry never receives the event.
 *
 * This is the reason the "Track this opportunity" failure surfaced as
 * a digest in the UI but never appeared in Sentry: server errors weren't
 * being captured at all.
 */
export const onRequestError = Sentry.captureRequestError;
