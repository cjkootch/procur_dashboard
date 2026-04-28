import { auth } from '@clerk/nextjs/server';
import { signDiscoverToken } from '@procur/utils';
import { NextResponse } from 'next/server';

/**
 * Mint a short-lived handshake token after Clerk auth, then bounce the
 * user back to Discover with the token in the URL hash.
 *
 * Discover sits on a different subdomain (discover.procur.app) and our
 * Clerk dev keys can't reliably share session cookies across origins.
 * The signed handshake token is the bridge: this endpoint runs in the
 * App's authenticated context, reads the Clerk userId, signs a token
 * with DISCOVER_HANDSHAKE_SECRET, and redirects to Discover. Discover's
 * client picks the token out of the URL hash, stores it, and uses it
 * to authenticate API calls back to discover.procur.app/api/assistant.
 *
 * Why hash, not query: hash fragments are not sent to the server when
 * the user follows the redirect, so the token doesn't appear in
 * Discover's HTTP access logs / Sentry breadcrumbs. Removed from the
 * URL by the bootstrap client immediately after read.
 *
 * If the user isn't signed into Clerk, the global middleware redirects
 * them to /sign-in first; after they sign in they bounce back here and
 * the handshake completes.
 *
 * Query params:
 *   - return: where on Discover to land. Defaults to the Discover root.
 *             Must be on the configured DISCOVER_URL host — we refuse
 *             arbitrary redirects to prevent open-redirect abuse.
 */
export const dynamic = 'force-dynamic';

const DISCOVER_URL = process.env.NEXT_PUBLIC_DISCOVER_URL ?? 'https://discover.procur.app';

export async function GET(req: Request) {
  const { userId, orgId } = await auth();
  if (!userId) {
    // Middleware should have caught this, but double-check so we never
    // mint an anonymous token. 401 is fine because the middleware
    // would have redirected for browser navigations.
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const secret = process.env.DISCOVER_HANDSHAKE_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: 'DISCOVER_HANDSHAKE_SECRET not configured' },
      { status: 500 },
    );
  }

  // Resolve return URL — must match DISCOVER_URL host to prevent open
  // redirects. Falls back to Discover root when unspecified or invalid.
  let target = DISCOVER_URL;
  const incomingReturn = new URL(req.url).searchParams.get('return');
  if (incomingReturn) {
    try {
      const parsed = new URL(incomingReturn);
      const allowed = new URL(DISCOVER_URL);
      if (parsed.host === allowed.host) {
        target = parsed.toString();
      }
    } catch {
      // Invalid URL — keep default.
    }
  }

  // orgId may be null when the user hasn't selected/created a Clerk
  // org yet (rare for app users — onboarding usually creates one — but
  // possible). Discover's API tolerates null orgId by running the
  // assistant without a backing company budget.
  const token = signDiscoverToken({ userId, orgId: orgId ?? null }, secret);
  // Hash fragment: not sent to server, scrubbed by client immediately.
  const url = new URL(target);
  url.hash = `_dt=${token}`;
  return NextResponse.redirect(url.toString());
}
