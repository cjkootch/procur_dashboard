'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { recordApprovalDecision } from '@procur/catalog';
import { dispatchApprovalExecutor } from '@procur/ai';
import { requireCompany } from '@procur/auth';

const FormSchema = z.object({
  id: z.string().min(1),
});

/**
 * Server actions backing the approve/reject buttons on the /approvals
 * page. Per Phase 2: record the decision. Per Phase 3+: dispatch the
 * matching executor inline. Inline (rather than a queue worker) is
 * deliberate — Trigger.dev v3→v4 is gated upstream and single-user
 * latency is acceptable. The dispatch is idempotent (each executor
 * short-circuits if `applied_at` is already set), so retries from the
 * UI don't double-fire.
 *
 * The dispatch table itself lives in `@procur/ai/agents/dispatch` so
 * the `/api/approvals/[id]/approve` API route (used by the inline
 * chat-card UI) can run the same code.
 */

export async function approveApprovalAction(formData: FormData): Promise<void> {
  const { user, company } = await requireCompany();
  const parsed = FormSchema.safeParse({ id: formData.get('id') });
  if (!parsed.success) return;
  const result = await recordApprovalDecision(parsed.data.id, {
    decision: 'approved',
    reviewerId: user.id,
  });
  if (result.row) {
    await dispatchApprovalExecutor(
      {
        id: result.row.id,
        actionType: result.row.actionType,
        proposedPayload: result.row.proposedPayload as Record<string, unknown>,
      },
      user.id,
      { companyId: company.id },
    );
  }
  revalidatePath('/approvals');
  revalidatePath(`/approvals/${parsed.data.id}`);
  revalidatePath('/inbox');
  revalidatePath('/leads');
  revalidatePath('/follow-ups');
  revalidatePath('/deals');
  revalidatePath('/signals');
  revalidatePath('/calls');
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
