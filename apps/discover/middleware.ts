import { clerkMiddleware } from '@clerk/nextjs/server';

/**
 * Discover is a public-browseable surface, so this middleware does NOT
 * gate any routes. Its only purpose is to make `auth()` and the
 * <SignedIn>/<SignedOut> components work — without clerkMiddleware
 * registered, ClerkProvider can't detect the session cookie and every
 * page renders as anonymous.
 *
 * If we later need to gate specific authenticated-only routes (e.g.,
 * a /me page or the AI assistant API), add a createRouteMatcher check
 * inside this handler that calls auth.protect() — same pattern as the
 * main app.
 */
export default clerkMiddleware();

export const config = {
  // Standard Clerk matcher — applies to everything except static
  // files. Keep this in sync with Clerk's recommended pattern.
  matcher: [
    '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    '/(api|trpc)(.*)',
  ],
};
