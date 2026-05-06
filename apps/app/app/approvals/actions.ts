'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { getApproval, recordApprovalDecision } from '@procur/catalog';
import {
  applyCloseLead,
  applyContactOptOut,
  applyContactTag,
  applyCreateCompany,
  applyCreateContact,
  applyCreateDeal,
  applyDealHumanReview,
  applyDealMilestone,
  applyDealSetBroker,
  applyDealStatusChange,
  applyEmailSend,
  applyOrgAddProduct,
  applyOrgLinkRelationship,
  applyOrgSetKind,
  applyOrgTag,
  applyOrgUpdateFields,
  applyScheduleFollowUp,
  parseCloseLeadPayload,
  parseCreateCompanyPayload,
  parseCreateContactPayload,
  parseCreateDealPayload,
  parseDealMilestonePayload,
  parseDealSetBrokerPayload,
  parseDealStatusChangePayload,
  parseEmailSendPayload,
  parseScheduleFollowUpPayload,
} from '@procur/ai';
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
    await dispatchExecutor(result.row, user.id);
  }
  revalidatePath('/approvals');
  revalidatePath(`/approvals/${parsed.data.id}`);
  revalidatePath('/inbox');
  revalidatePath('/leads');
  revalidatePath('/follow-ups');
  revalidatePath('/deals');
}

interface ApprovalRowForExecutor {
  id: string;
  actionType: string;
  proposedPayload: Record<string, unknown>;
}

/**
 * Dispatch known per-action executors. Each phase adds its handlers
 * here; un-wired action types record the decision but stay un-executed.
 */
async function dispatchExecutor(
  row: ApprovalRowForExecutor,
  reviewerId: string,
): Promise<void> {
  // ---- Phase 3 ------------------------------------------------------------
  if (row.actionType === 'email.send') {
    const payload = parseEmailSendPayload(row.proposedPayload);
    if (!payload) return;
    await applyEmailSend(row.id, payload);
    return;
  }

  // ---- Phase 4 ------------------------------------------------------------
  if (row.actionType === 'crm.create_company') {
    const payload = parseCreateCompanyPayload(row.proposedPayload);
    if (!payload) return;
    await applyCreateCompany(row.id, payload);
    return;
  }
  if (row.actionType === 'crm.create_contact') {
    const payload = parseCreateContactPayload(row.proposedPayload);
    if (!payload) return;
    await applyCreateContact(row.id, payload);
    return;
  }
  if (row.actionType === 'lead.close') {
    const payload = parseCloseLeadPayload(row.proposedPayload);
    if (!payload) return;
    await applyCloseLead(row.id, payload);
    return;
  }
  if (row.actionType === 'follow_up.schedule') {
    const payload = parseScheduleFollowUpPayload(row.proposedPayload);
    if (!payload) return;
    await applyScheduleFollowUp(row.id, payload, reviewerId);
    return;
  }
  if (
    row.actionType === 'org.set_kind' &&
    typeof row.proposedPayload['orgId'] === 'string' &&
    typeof row.proposedPayload['orgKind'] === 'string'
  ) {
    await applyOrgSetKind(row.id, {
      orgId: row.proposedPayload['orgId'] as string,
      orgKind: row.proposedPayload['orgKind'] as string,
    });
    return;
  }
  if (
    row.actionType === 'org.add_product' &&
    typeof row.proposedPayload['orgId'] === 'string' &&
    typeof row.proposedPayload['product'] === 'string'
  ) {
    const orgId = row.proposedPayload['orgId'] as string;
    const product = row.proposedPayload['product'] as string;
    const notes =
      typeof row.proposedPayload['notes'] === 'string'
        ? (row.proposedPayload['notes'] as string)
        : undefined;
    await applyOrgAddProduct(
      row.id,
      notes !== undefined ? { orgId, product, notes } : { orgId, product },
      reviewerId,
    );
    return;
  }
  if (
    row.actionType === 'org.link_relationship' &&
    typeof row.proposedPayload['fromOrgId'] === 'string' &&
    typeof row.proposedPayload['toOrgId'] === 'string' &&
    typeof row.proposedPayload['relationshipType'] === 'string'
  ) {
    const product =
      typeof row.proposedPayload['product'] === 'string'
        ? (row.proposedPayload['product'] as string)
        : undefined;
    await applyOrgLinkRelationship(
      row.id,
      {
        fromOrgId: row.proposedPayload['fromOrgId'] as string,
        toOrgId: row.proposedPayload['toOrgId'] as string,
        relationshipType: row.proposedPayload['relationshipType'] as string,
        ...(product !== undefined ? { product } : {}),
      },
      reviewerId,
    );
    return;
  }
  if (
    (row.actionType === 'org.tag' || row.actionType === 'org.untag') &&
    typeof row.proposedPayload['orgId'] === 'string' &&
    typeof row.proposedPayload['tag'] === 'string'
  ) {
    await applyOrgTag(
      row.id,
      {
        orgId: row.proposedPayload['orgId'] as string,
        tag: row.proposedPayload['tag'] as string,
      },
      row.actionType === 'org.tag' ? 'add' : 'remove',
    );
    return;
  }
  if (
    (row.actionType === 'contact.tag' || row.actionType === 'contact.untag') &&
    typeof row.proposedPayload['contactId'] === 'string' &&
    typeof row.proposedPayload['tag'] === 'string'
  ) {
    await applyContactTag(
      row.id,
      {
        contactId: row.proposedPayload['contactId'] as string,
        tag: row.proposedPayload['tag'] as string,
      },
      row.actionType === 'contact.tag' ? 'add' : 'remove',
    );
    return;
  }
  if (
    row.actionType === 'contact.opt_out' &&
    typeof row.proposedPayload['contactId'] === 'string' &&
    typeof row.proposedPayload['reason'] === 'string'
  ) {
    await applyContactOptOut(row.id, {
      contactId: row.proposedPayload['contactId'] as string,
      reason: row.proposedPayload['reason'] as string,
    });
    return;
  }
  if (
    row.actionType === 'org.update_fields' &&
    typeof row.proposedPayload['orgId'] === 'string' &&
    row.proposedPayload['patch'] &&
    typeof row.proposedPayload['patch'] === 'object'
  ) {
    await applyOrgUpdateFields(row.id, {
      orgId: row.proposedPayload['orgId'] as string,
      patch: row.proposedPayload['patch'] as {
        domain?: string | null;
        industry?: string | null;
        country?: string | null;
      },
    });
    return;
  }

  // ---- Phase 5 ------------------------------------------------------------
  if (row.actionType === 'crm.create_deal') {
    const payload = parseCreateDealPayload(row.proposedPayload);
    if (!payload) return;
    await applyCreateDeal(row.id, payload, reviewerId);
    return;
  }
  if (row.actionType === 'deal.status_change') {
    const payload = parseDealStatusChangePayload(row.proposedPayload);
    if (!payload) return;
    await applyDealStatusChange(row.id, payload);
    return;
  }
  if (row.actionType === 'deal.milestone') {
    const payload = parseDealMilestonePayload(row.proposedPayload);
    if (!payload) return;
    await applyDealMilestone(row.id, payload);
    return;
  }
  if (row.actionType === 'deal.set_broker') {
    const payload = parseDealSetBrokerPayload(row.proposedPayload);
    if (!payload) return;
    await applyDealSetBroker(row.id, payload);
    return;
  }
  if (
    row.actionType === 'deal.human_review' &&
    typeof row.proposedPayload['dealId'] === 'string'
  ) {
    await applyDealHumanReview(
      row.id,
      row.proposedPayload['dealId'] as string,
    );
    return;
  }

  // Phase 6 (sanctions) → sanctions.screen
  // Phase 7 (voice) → outbound_call
  void getApproval; // helper retained for follow-up phases
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
