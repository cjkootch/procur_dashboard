'use server';

import { revalidatePath } from 'next/cache';
import { requireCompany } from '@procur/auth';
import {
  SupplierApprovalEntityMissingError,
  upsertSupplierApproval,
} from '@procur/catalog';
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
  try {
    await upsertSupplierApproval({
      companyId: company.id,
      userId: user.id,
      entitySlug: input.entitySlug,
      entityName: input.entityName ?? null,
      status: input.status,
      expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
      notes: input.notes ?? null,
    });
  } catch (err) {
    // The form lives on the entity profile page so the slug
    // SHOULD resolve. If we hit the missing-entity guard it means
    // someone hand-crafted the slug or a stale form is in flight;
    // either way, re-throwing as a plain Error keeps the standard
    // server-action error boundary path.
    if (err instanceof SupplierApprovalEntityMissingError) {
      throw new Error(err.message);
    }
    throw err;
  }
  revalidatePath(`/entities/${input.entitySlug}`);
  revalidatePath('/suppliers/known-entities');
  revalidatePath('/settings');
}
