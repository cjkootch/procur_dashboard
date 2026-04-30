'use server';

import { revalidatePath } from 'next/cache';
import { requireCompany } from '@procur/auth';
import { upsertSupplierApproval } from '@procur/catalog';
import {
  isSupplierApprovalStatus,
  type SupplierApprovalStatus,
} from '@procur/db';

export type SetSupplierApprovalInput = {
  entitySlug: string;
  entityName?: string | null;
  status: SupplierApprovalStatus;
  expiresAt?: string | null;
  notes?: string | null;
};

/**
 * Server action invoked from the entity profile page approval form.
 * Validates status against the enum and writes via the shared
 * upsert helper.
 */
export async function setSupplierApprovalAction(
  input: SetSupplierApprovalInput,
): Promise<void> {
  const { company, user } = await requireCompany();
  if (!isSupplierApprovalStatus(input.status)) {
    throw new Error(`Invalid supplier approval status: ${input.status}`);
  }
  await upsertSupplierApproval({
    companyId: company.id,
    userId: user.id,
    entitySlug: input.entitySlug,
    entityName: input.entityName ?? null,
    status: input.status,
    expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
    notes: input.notes ?? null,
  });
  revalidatePath(`/entities/${input.entitySlug}`);
  revalidatePath('/suppliers/known-entities');
  revalidatePath('/settings');
}
