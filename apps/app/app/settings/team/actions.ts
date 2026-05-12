'use server';

import { clerkClient } from '@clerk/nextjs/server';
import { requireCompany } from '@procur/auth';
import { revalidatePath } from 'next/cache';

const INVITE_ROLES = new Set(['org:admin', 'org:member']);

function assertCanManage(role: string) {
  if (role !== 'owner' && role !== 'admin') {
    throw new Error('Only owners and admins can manage the team.');
  }
}

export async function inviteTeamMemberAction(formData: FormData): Promise<void> {
  const { user, company } = await requireCompany();
  assertCanManage(user.role);

  const email = String(formData.get('email') ?? '').trim().toLowerCase();
  const role = String(formData.get('role') ?? 'org:member');

  if (!email || !email.includes('@')) {
    throw new Error('Enter a valid email address.');
  }
  if (!INVITE_ROLES.has(role)) {
    throw new Error('Invalid role.');
  }

  const client = await clerkClient();
  await client.organizations.createOrganizationInvitation({
    organizationId: company.clerkOrgId,
    emailAddress: email,
    role,
    inviterUserId: user.clerkId,
  });

  revalidatePath('/settings/team');
}

export async function revokeInvitationAction(formData: FormData): Promise<void> {
  const { user, company } = await requireCompany();
  assertCanManage(user.role);

  const invitationId = String(formData.get('invitationId') ?? '');
  if (!invitationId) {
    throw new Error('Invitation ID required.');
  }

  const client = await clerkClient();
  await client.organizations.revokeOrganizationInvitation({
    organizationId: company.clerkOrgId,
    invitationId,
    requestingUserId: user.clerkId,
  });

  revalidatePath('/settings/team');
}

export async function removeMemberAction(formData: FormData): Promise<void> {
  const { user, company } = await requireCompany();
  assertCanManage(user.role);

  const memberClerkId = String(formData.get('userId') ?? '');
  if (!memberClerkId) {
    throw new Error('User ID required.');
  }
  if (memberClerkId === user.clerkId) {
    throw new Error('You cannot remove yourself. Ask another admin to do it.');
  }

  const client = await clerkClient();
  await client.organizations.deleteOrganizationMembership({
    organizationId: company.clerkOrgId,
    userId: memberClerkId,
  });

  revalidatePath('/settings/team');
}
