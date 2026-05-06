'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { recordApprovalDecision } from '@procur/catalog';
import { requireCompany } from '@procur/auth';

const FormSchema = z.object({
  id: z.string().min(1),
});

/**
 * Server actions backing the approve/reject buttons on the approval
 * queue. Per docs/vex-into-procur-merge-brief.md Phase 2 — the
 * decision is recorded; the executor that applies the side-effect
 * (email send, deal create, etc.) lands in Phase 3+ per domain.
 */

export async function approveApprovalAction(formData: FormData): Promise<void> {
  const { user } = await requireCompany();
  const parsed = FormSchema.safeParse({ id: formData.get('id') });
  if (!parsed.success) return;
  await recordApprovalDecision(parsed.data.id, {
    decision: 'approved',
    reviewerId: user.id,
  });
  revalidatePath('/approvals');
  revalidatePath(`/approvals/${parsed.data.id}`);
}

export async function rejectApprovalAction(formData: FormData): Promise<void> {
  const { user } = await requireCompany();
  const parsed = FormSchema.safeParse({ id: formData.get('id') });
  if (!parsed.success) return;
  await recordApprovalDecision(parsed.data.id, {
    decision: 'rejected',
    reviewerId: user.id,
  });
  revalidatePath('/approvals');
  revalidatePath(`/approvals/${parsed.data.id}`);
}
