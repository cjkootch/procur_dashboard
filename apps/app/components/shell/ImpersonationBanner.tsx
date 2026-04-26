import { auth } from '@clerk/nextjs/server';
import { eq } from 'drizzle-orm';
import { db, users } from '@procur/db';
import { ExitImpersonationButton } from './ExitImpersonationButton';

/**
 * Server component rendered at the top of every authenticated page.
 *
 * Detects Clerk impersonation via `sessionClaims.act.sub` (the actor's
 * Clerk user id; set when the staff user redeemed an actor token from
 * the admin app) and renders a loud banner so the staff member can't
 * forget they're not viewing the app as themselves.
 *
 * Renders nothing in normal sessions.
 */
export async function ImpersonationBanner() {
  // The root layout renders this on every route — including Next's
  // internal /_not-found shell, which is served without running
  // clerkMiddleware. auth() throws there ("Clerk: auth() was called
  // but Clerk can't detect usage of clerkMiddleware()"). The banner
  // is purely a staff-impersonation indicator, so failing closed
  // (render nothing) is the right behavior whenever we can't read
  // the session.
  let sessionClaims: Awaited<ReturnType<typeof auth>>['sessionClaims'] = null;
  try {
    ({ sessionClaims } = await auth());
  } catch {
    return null;
  }
  const actor = sessionClaims?.act as { sub?: string } | undefined;
  if (!actor?.sub) return null;

  // Look up the actor by their Clerk id so we can show "by Alice from
  // Procur" instead of an opaque user_… string. Best-effort: if the
  // staff member isn't in our users table for some reason, we still
  // render the banner with the raw sub.
  const actorRow = await db.query.users.findFirst({
    where: eq(users.clerkId, actor.sub),
    columns: { firstName: true, lastName: true, email: true },
  });
  const actorName =
    actorRow == null
      ? actor.sub
      : [actorRow.firstName, actorRow.lastName].filter(Boolean).join(' ') ||
        actorRow.email;

  return (
    <div
      role="alert"
      className="sticky top-0 z-50 flex flex-wrap items-center justify-between gap-3 border-b-2 border-amber-500 bg-amber-100 px-4 py-2 text-xs text-amber-950"
    >
      <p>
        <span className="font-semibold">Impersonation active</span>
        {' · '}You&rsquo;re viewing as the customer&rsquo;s user. Original sign-in:{' '}
        <span className="font-medium">{actorName}</span>.
      </p>
      <ExitImpersonationButton />
    </div>
  );
}
