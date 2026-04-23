import { auth } from '@clerk/nextjs/server';
import { db, users, companies } from '@procur/db';
import { eq } from 'drizzle-orm';
import { redirect } from 'next/navigation';
import type { AuthContext, CurrentCompany, CurrentUser } from './types';

export async function getCurrentUser(): Promise<CurrentUser | null> {
  const { userId } = await auth();
  if (!userId) return null;

  const row = await db.query.users.findFirst({
    where: eq(users.clerkId, userId),
  });
  return row ?? null;
}

export async function getCurrentCompany(): Promise<CurrentCompany | null> {
  const { orgId } = await auth();
  if (!orgId) return null;

  const row = await db.query.companies.findFirst({
    where: eq(companies.clerkOrgId, orgId),
  });
  return row ?? null;
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
