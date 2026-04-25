import 'server-only';
import { auth } from '@clerk/nextjs/server';
import { redirect } from 'next/navigation';
import { eq } from 'drizzle-orm';
import { db, users } from '@procur/db';

/**
 * Admin allow-list. Comma-separated list of email addresses authorized
 * to access the Procur admin app. Configured via env so adding/removing
 * an admin doesn't require a deploy.
 *
 * If unset, NO ONE is authorized (fail-closed). The admin app is
 * deployed at admin.procur.app behind Clerk; this is a second-gate
 * after authentication so a leaked customer session cannot reach
 * cross-tenant data.
 */
function adminEmails(): Set<string> {
  const raw = process.env.PROCUR_ADMIN_EMAILS ?? '';
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 0),
  );
}

export type AdminUser = {
  id: string;
  /** Clerk user id — needed when minting an actor token to impersonate
      another user; the actor.sub claim must reference the staff member. */
  clerkId: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
};

/**
 * Resolve the current user and verify they're on the admin allow-list.
 * Redirects to Clerk sign-in if no session; throws on the membership
 * check (the admin app is internal — leaking a 403 with the user's
 * email vs a generic redirect is fine).
 */
export async function requireAdmin(): Promise<AdminUser> {
  const { userId } = await auth();
  if (!userId) redirect('/sign-in');

  const row = await db.query.users.findFirst({
    where: eq(users.clerkId, userId),
    columns: {
      id: true,
      clerkId: true,
      email: true,
      firstName: true,
      lastName: true,
    },
  });
  if (!row) {
    throw new Error('admin: signed-in user is not in the procur users table');
  }

  const allowed = adminEmails();
  if (!allowed.has(row.email.toLowerCase())) {
    throw new Error(
      `admin: ${row.email} is not on the PROCUR_ADMIN_EMAILS allow-list`,
    );
  }

  return row;
}

/** True if the env allow-list is configured at all. Used to render a
 *  "configure PROCUR_ADMIN_EMAILS" notice on first run. */
export function isAdminConfigured(): boolean {
  return adminEmails().size > 0;
}
