export const dynamic = "force-dynamic";

class SentryExampleAPIError extends Error {
  constructor(message: string | undefined) {
    super(message);
    this.name = "SentryExampleAPIError";
  }
}

// A faulty API route to test Sentry's error monitoring. The wizard's
// generated version called Sentry.logger which is a v9 API; we're on
// v8 so it's omitted — instrumentation.ts's onRequestError hook still
// ships the thrown exception to Sentry.
export function GET() {
  throw new SentryExampleAPIError(
    "This error is raised on the backend called by the example page.",
  );
}
