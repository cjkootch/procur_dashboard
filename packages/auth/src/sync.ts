import {
  db,
  users,
  companies,
  pursuits,
  pursuitTasks,
} from '@procur/db';
import { eq } from 'drizzle-orm';

type ClerkUserEvent = {
  id: string;
  email_addresses?: Array<{ email_address: string; id: string }>;
  primary_email_address_id?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  image_url?: string | null;
};

type ClerkOrgEvent = {
  id: string;
  name: string;
  slug?: string | null;
  image_url?: string | null;
};

type ClerkMembershipEvent = {
  public_user_data: { user_id: string };
  organization: { id: string };
  role?: string | null;
};

function primaryEmail(data: ClerkUserEvent): string {
  const primary = data.email_addresses?.find((e) => e.id === data.primary_email_address_id);
  return primary?.email_address ?? data.email_addresses?.[0]?.email_address ?? '';
}

function mapRole(clerkRole: string | null | undefined): 'owner' | 'admin' | 'member' | 'viewer' {
  if (!clerkRole) return 'member';
  if (clerkRole.endsWith(':admin') || clerkRole === 'admin' || clerkRole === 'org:admin') {
    return 'admin';
  }
  if (clerkRole === 'org:owner') return 'owner';
  return 'member';
}

export async function upsertUserFromClerk(data: ClerkUserEvent): Promise<void> {
  await db
    .insert(users)
    .values({
      clerkId: data.id,
      email: primaryEmail(data),
      firstName: data.first_name ?? null,
      lastName: data.last_name ?? null,
      imageUrl: data.image_url ?? null,
    })
    .onConflictDoUpdate({
      target: users.clerkId,
      set: {
        email: primaryEmail(data),
        firstName: data.first_name ?? null,
        lastName: data.last_name ?? null,
        imageUrl: data.image_url ?? null,
        updatedAt: new Date(),
      },
    });
}

export async function deleteUserFromClerk(clerkUserId: string): Promise<void> {
  await db.delete(users).where(eq(users.clerkId, clerkUserId));
}

export async function upsertCompanyFromClerk(data: ClerkOrgEvent): Promise<void> {
  const slug =
    data.slug ??
    data.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');

  await db
    .insert(companies)
    .values({
      clerkOrgId: data.id,
      name: data.name,
      slug,
      logoUrl: data.image_url ?? null,
    })
    .onConflictDoUpdate({
      target: companies.clerkOrgId,
      set: {
        name: data.name,
        slug,
        logoUrl: data.image_url ?? null,
        updatedAt: new Date(),
      },
    });
}

export async function deleteCompanyFromClerk(clerkOrgId: string): Promise<void> {
  await db.delete(companies).where(eq(companies.clerkOrgId, clerkOrgId));
}

export async function applyMembership(data: ClerkMembershipEvent): Promise<void> {
  const company = await db.query.companies.findFirst({
    where: eq(companies.clerkOrgId, data.organization.id),
  });
  if (!company) return;

  await db
    .update(users)
    .set({
      companyId: company.id,
      role: mapRole(data.role),
      updatedAt: new Date(),
    })
    .where(eq(users.clerkId, data.public_user_data.user_id));
}

export async function removeMembership(data: ClerkMembershipEvent): Promise<void> {
  // Clear assignments on the user before unbinding them. Without this,
  // a removed teammate would still appear as the assignee on pursuits +
  // tasks they no longer have access to — and the cascade rules only
  // fire on a full user delete, not a membership change.
  const user = await db.query.users.findFirst({
    where: eq(users.clerkId, data.public_user_data.user_id),
    columns: { id: true },
  });
  if (user) {
    await db
      .update(pursuits)
      .set({ assignedUserId: null, updatedAt: new Date() })
      .where(eq(pursuits.assignedUserId, user.id));
    await db
      .update(pursuits)
      .set({ captureManagerId: null, updatedAt: new Date() })
      .where(eq(pursuits.captureManagerId, user.id));
    await db
      .update(pursuitTasks)
      .set({ assignedUserId: null, updatedAt: new Date() })
      .where(eq(pursuitTasks.assignedUserId, user.id));
  }

  await db
    .update(users)
    .set({ companyId: null, role: 'member', updatedAt: new Date() })
    .where(eq(users.clerkId, data.public_user_data.user_id));
}

export type ClerkWebhookEvent =
  | { type: 'user.created' | 'user.updated'; data: ClerkUserEvent }
  | { type: 'user.deleted'; data: { id: string } }
  | { type: 'organization.created' | 'organization.updated'; data: ClerkOrgEvent }
  | { type: 'organization.deleted'; data: { id: string } }
  | {
      type: 'organizationMembership.created' | 'organizationMembership.updated';
      data: ClerkMembershipEvent;
    }
  | { type: 'organizationMembership.deleted'; data: ClerkMembershipEvent };

export async function handleClerkWebhook(event: ClerkWebhookEvent): Promise<void> {
  switch (event.type) {
    case 'user.created':
    case 'user.updated':
      await upsertUserFromClerk(event.data);
      return;
    case 'user.deleted':
      await deleteUserFromClerk(event.data.id);
      return;
    case 'organization.created':
    case 'organization.updated':
      await upsertCompanyFromClerk(event.data);
      return;
    case 'organization.deleted':
      await deleteCompanyFromClerk(event.data.id);
      return;
    case 'organizationMembership.created':
    case 'organizationMembership.updated':
      await applyMembership(event.data);
      return;
    case 'organizationMembership.deleted':
      await removeMembership(event.data);
      return;
  }
}
