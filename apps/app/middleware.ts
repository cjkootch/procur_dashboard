import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';
import { NextResponse } from 'next/server';

const isPublicRoute = createRouteMatcher([
  '/sign-in(.*)',
  '/sign-up(.*)',
  '/api/webhooks/(.*)',
  '/api/health',
  // Root-level liveness probe — used by Fly.io / vex's
  // /admin/procur/healthcheck to confirm the service is reachable.
  '/health',
  // Word add-in API: token-authed via Authorization: Bearer header.
  // Clerk session does not exist on these requests (the taskpane runs
  // outside the browser cookie context); each route handler calls
  // authenticateWordAddinRequest() to gate access.
  '/api/word-addin/(.*)',
  // Intelligence API: token-authed via Authorization: Bearer
  // ${PROCUR_API_TOKEN}. Called by vex's procur_enrichment agent
  // (and any future S2S consumer); no Clerk session exists on the
  // request. Each route handler calls verifyIntelligenceToken() to
  // gate access — Clerk must let these through unauthenticated so
  // the bearer check is what actually decides.
  '/api/intelligence/(.*)',
]);

export default clerkMiddleware(async (auth, req) => {
  if (isPublicRoute(req)) return;

  const { userId } = await auth();
  if (!userId) {
    const signInUrl = new URL('/sign-in', req.url);
    signInUrl.searchParams.set('redirect_url', req.url);
    return NextResponse.redirect(signInUrl);
  }
});

export const config = {
  matcher: [
    '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    '/(api|trpc)(.*)',
  ],
};
