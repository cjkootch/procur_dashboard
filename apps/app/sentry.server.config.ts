import * as Sentry from '@sentry/nextjs';

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  // Include the request IP / headers / cookies on captured events so we
  // can correlate to the user when triaging.
  sendDefaultPii: true,
  // 100% in dev so every interaction shows up locally; 10% in prod to
  // keep the bill bounded.
  tracesSampleRate: process.env.NODE_ENV === 'development' ? 1.0 : 0.1,
  // Attach local variable values to stack frames — when the next
  // "Track this opportunity"-style error fires we'll see exactly which
  // field was nullish without having to repro.
  includeLocalVariables: true,
  debug: false,
});
