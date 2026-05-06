'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { getApproval, recordApprovalDecision } from '@procur/catalog';
import { applyEmailSend, parseEmailSendPayload } from '@procur/ai';
import { requireCompany } from '@procur/auth';

const FormSchema = z.object({
  id: z.string().min(1),
});

/**
 * Server actions backing the approve/reject buttons on the approval
 * queue. Per Phase 2: record the decision. Per Phase 3: dispatch
 * known executors INLINE for action types that have one. Inline
 * (rather than queue-worker) is deliberate — Trigger.dev v3→v4 is
 * gated upstream and single-user latency is acceptable. The dispatch
 * is idempotent (the executor short-circuits if applied_at is
 * already set), so retries from the UI don't double-fire.
 */

export async function approveApprovalAction(formData: FormData): Promise<void> {
  const { user } = await requireCompany();
  const parsed = FormSchema.safeParse({ id: formData.get('id') });
  if (!parsed.success) return;
  const result = await recordApprovalDecision(parsed.data.id, {
    decision: 'approved',
    reviewerId: user.id,
  });
  if (result.row) {
    await dispatchExecutor(result.row);
  }
  revalidatePath('/approvals');
  revalidatePath(`/approvals/${parsed.data.id}`);
  revalidatePath('/inbox');
}

interface ApprovalRowForExecutor {
  id: string;
  actionType: string;
  proposedPayload: Record<string, unknown>;
}

/**
 * Dispatch known per-action executors. Phase 3 wires `email.send`;
 * other action types remain pending side-effects until their
 * respective phases land their executors.
 */
async function dispatchExecutor(row: ApprovalRowForExecutor): Promise<void> {
  if (row.actionType === 'email.send') {
    const payload = parseEmailSendPayload(row.proposedPayload);
    if (!payload) return;
    await applyEmailSend(row.id, payload);
  }
  // Phase 4 (sales) → crm.create_*, contact.update, contact.merge, …
  // Phase 5 (deals) → crm.create_deal, deal.status_change, deal.set_broker, …
  // Phase 6 (sanctions) → sanctions.screen
  // Phase 7 (voice) → outbound_call
  // The action types currently without executors stay pending; the
  // approve button still records the decision so the audit trail is
  // consistent.
  void getApproval; // re-export helper kept for follow-up phases
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
