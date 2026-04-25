import { auth, clerkClient } from '@clerk/nextjs/server';
import { db, users, companies } from '@procur/db';
import { eq } from 'drizzle-orm';
import { redirect } from 'next/navigation';
import { applyMembership, upsertCompanyFromClerk, upsertUserFromClerk } from './sync';
import type { AuthContext, CurrentCompany, CurrentUser } from './types';

/**
 * Synchronously sync a Clerk user → our `users` row when the async
 * webhook hasn't landed yet. Without this, brand-new sign-ups bounce
 * between /sign-in and the requested page in a loop until the webhook
 * arrives. The webhook is still the canonical sync; this is a
 * best-effort cold-start fallback.
 *
 * Failures are swallowed (return null) so a transient Clerk outage
 * doesn't make the auth helpers throw — the caller will redirect to
 * sign-in and the user can retry.
 */
async function hydrateUserFromClerk(clerkUserId: string): Promise<CurrentUser | null> {
  try {
    const client = await clerkClient();
    const u = await client.users.getUser(clerkUserId);
    await upsertUserFromClerk({
      id: u.id,
      email_addresses: u.emailAddresses.map((e) => ({
        email_address: e.emailAddress,
        id: e.id,
      })),
      primary_email_address_id: u.primaryEmailAddressId ?? null,
      first_name: u.firstName ?? null,
      last_name: u.lastName ?? null,
      image_url: u.imageUrl ?? null,
    });
    return (
      (await db.query.users.findFirst({ where: eq(users.clerkId, clerkUserId) })) ?? null
    );
  } catch (err) {
    console.error('[auth] hydrateUserFromClerk failed', err);
    return null;
  }
}

/**
 * Same fallback as the user variant: synchronously sync a Clerk org →
 * our `companies` row + the membership row when the webhook hasn't
 * landed yet. Used on the very first request after org creation.
 */
async function hydrateCompanyFromClerk(
  clerkOrgId: string,
  clerkUserId: string,
): Promise<CurrentCompany | null> {
  try {
    const client = await clerkClient();
    const org = await client.organizations.getOrganization({ organizationId: clerkOrgId });
    await upsertCompanyFromClerk({
      id: org.id,
      name: org.name,
      slug: org.slug ?? null,
      image_url: org.imageUrl ?? null,
    });
    // Bind the requesting user to this company so requireCompany() works
    // immediately. The membership webhook may arrive later but will be a
    // no-op idempotent update (mapRole result is the same).
    try {
      const membershipList = await client.organizations.getOrganizationMembershipList({
        organizationId: clerkOrgId,
      });
      const mine = membershipList.data.find(
        (m) => m.publicUserData?.userId === clerkUserId,
      );
      if (mine) {
        await applyMembership({
          public_user_data: { user_id: clerkUserId },
          organization: { id: clerkOrgId },
          role: mine.role ?? null,
        });
      }
    } catch (err) {
      // Membership hydration is best-effort; the user gets redirected to
      // /onboarding if it fails, and the webhook will sort it out.
      console.warn('[auth] membership hydration failed', err);
    }
    return (
      (await db.query.companies.findFirst({ where: eq(companies.clerkOrgId, clerkOrgId) })) ??
      null
    );
  } catch (err) {
    console.error('[auth] hydrateCompanyFromClerk failed', err);
    return null;
  }
}

export async function getCurrentUser(): Promise<CurrentUser | null> {
  const { userId } = await auth();
  if (!userId) return null;

  const row = await db.query.users.findFirst({
    where: eq(users.clerkId, userId),
  });
  if (row) return row;
  // Cold-start: Clerk says signed in but our webhook hasn't synced yet.
  return hydrateUserFromClerk(userId);
}

export async function getCurrentCompany(): Promise<CurrentCompany | null> {
  const { userId, orgId } = await auth();
  if (!orgId) return null;

  const row = await db.query.companies.findFirst({
    where: eq(companies.clerkOrgId, orgId),
  });
  if (row) return row;
  // Cold-start: org just created, webhook hasn't landed.
  if (!userId) return null;
  return hydrateCompanyFromClerk(orgId, userId);
}

export async function requireUser(): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) redirect('/sign-in');
  return user;
}

export async function requireCompany(): Promise<AuthContext & { company: CurrentCompany }> {
  const user = await requireUser();
  const company = await getCurrentCompany();
  if (!company) redirect('/onboarding');
  return { user, company };
}
