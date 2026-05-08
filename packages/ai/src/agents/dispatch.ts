import { applyEmailSend, parseEmailSendPayload } from '../executors/email-send';
import {
  applyLeadFormSubmit,
  parseLeadFormSubmitPayload,
} from '../executors/lead-form-submit';
import {
  applyRvmDispatch,
  parseRvmDispatchPayload,
} from '../executors/rvm-dispatch';
import {
  applyCreateCompany,
  applyCreateContact,
  applyCloseLead,
  applyScheduleFollowUp,
  applyOrgSetKind,
  applyOrgAddProduct,
  applyOrgLinkRelationship,
  applyOrgTag,
  applyContactTag,
  applyContactOptOut,
  applyOrgUpdateFields,
  parseCreateCompanyPayload,
  parseCreateContactPayload,
  parseCloseLeadPayload,
  parseScheduleFollowUpPayload,
} from '../executors/sales';
import {
  applyCreateDeal,
  applyDealAttach,
  applyDealEvaluate,
  applyDealStatusChange,
  applyDealMilestone,
  applyDealSetBroker,
  applyDealHumanReview,
  parseCreateDealPayload,
  parseDealAttachPayload,
  parseDealEvaluatePayload,
  parseDealStatusChangePayload,
  parseDealMilestonePayload,
  parseDealSetBrokerPayload,
} from '../executors/deals';
import {
  applySanctionsScreen,
  parseSanctionsScreenPayload,
} from '../executors/sanctions';
import {
  applySmsSend,
  applyWhatsAppSend,
  applyWhatsAppSendTemplate,
  applyOutboundCall,
  parseSmsSendPayload,
  parseWhatsAppSendPayload,
  parseWhatsAppSendTemplatePayload,
  parseOutboundCallPayload,
} from '../executors/twilio';
import {
  applyCreateMission,
  parseCreateMissionPayload,
} from '../executors/missions';
import {
  applyArchiveCommunicationTemplate,
  applySaveCommunicationTemplate,
  parseArchiveCommunicationTemplatePayload,
  parseSaveCommunicationTemplatePayload,
} from '../executors/communication-templates';

/**
 * Approval row shape this dispatch table needs. Subset of the full
 * approvals row — only the fields required to look up the right
 * executor and run it.
 */
export interface ApprovalRowForExecutor {
  id: string;
  actionType: string;
  proposedPayload: Record<string, unknown>;
}

export interface DispatchOptions {
  /**
   * Company id of the approver — propagated to executors that need
   * tenant-scoped configuration (currently only the email executor,
   * which reads /settings/email defaults). Without this, the email
   * executor falls back to the most-recently-created company row,
   * which leaks settings across tenants the moment a second tenant
   * exists.
   */
  companyId?: string;
}

/**
 * Dispatch a recorded-approved approval row to the matching executor.
 *
 * Two callers today:
 *   1. /approvals page server action (apps/app/app/approvals/actions.ts)
 *   2. /api/approvals/[id]/approve route handler (apps/app/app/api/...)
 *
 * Both must dispatch identically — before this lived in only the
 * server action, the API route silently recorded the decision but
 * never fired the executor, so chat-card approvals did nothing
 * (the inline-card UX in apps/app/components/assistant/ApprovalActionCard).
 *
 * Idempotent: every executor short-circuits on `appliedAt`, so
 * concurrent or retried calls are safe.
 *
 * Un-wired action types are silently no-op — they record the
 * decision in the approvals row but produce no side effect. This
 * matches the pre-extraction behavior.
 */
export async function dispatchApprovalExecutor(
  row: ApprovalRowForExecutor,
  reviewerId: string,
  options: DispatchOptions = {},
): Promise<void> {
  // ---- Phase 3 ------------------------------------------------------------
  if (row.actionType === 'email.send') {
    const payload = parseEmailSendPayload(row.proposedPayload);
    if (!payload) return;
    await applyEmailSend(
      row.id,
      payload,
      options.companyId ? { companyId: options.companyId } : {},
    );
    return;
  }

  // Lead-form submission. Operator approval flips this from 'pending'
  // to 'approved' (or chat tool inserts as 'auto_approved' for tier-2
  // probes); the dispatcher routes here and the executor re-verifies
  // CAPTCHA / submit_method eligibility live before POSTing.
  if (row.actionType === 'lead_form.submit') {
    const payload = parseLeadFormSubmitPayload(row.proposedPayload);
    if (!payload) return;
    await applyLeadFormSubmit(
      row.id,
      payload,
      options.companyId ? { companyId: options.companyId } : {},
    );
    return;
  }

  // Ringless voicemail dispatch. Operator approval flips this from
  // 'pending' to 'approved' (or 'auto_approved' for tier-2 probes);
  // executor re-checks compliance gates (quiet hours, cooldown,
  // audio asset present) live before placing the Twilio call.
  if (row.actionType === 'rvm.dispatch') {
    const payload = parseRvmDispatchPayload(row.proposedPayload);
    if (!payload) return;
    await applyRvmDispatch(
      row.id,
      payload,
      options.companyId ? { companyId: options.companyId } : {},
    );
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
  if (row.actionType === 'deal.evaluate') {
    const payload = parseDealEvaluatePayload(row.proposedPayload);
    if (!payload) return;
    await applyDealEvaluate(row.id, payload);
    return;
  }
  if (row.actionType === 'deal.attach') {
    const payload = parseDealAttachPayload(row.proposedPayload);
    if (!payload) return;
    await applyDealAttach(row.id, payload);
    return;
  }

  // ---- Communication templates -------------------------------------------
  if (row.actionType === 'template.save') {
    const payload = parseSaveCommunicationTemplatePayload(row.proposedPayload);
    if (!payload) return;
    await applySaveCommunicationTemplate(row.id, payload, reviewerId);
    return;
  }
  if (row.actionType === 'template.archive') {
    const payload = parseArchiveCommunicationTemplatePayload(
      row.proposedPayload,
    );
    if (!payload) return;
    await applyArchiveCommunicationTemplate(row.id, payload);
    return;
  }

  // ---- Phase 6 ------------------------------------------------------------
  if (row.actionType === 'sanctions.screen') {
    const payload = parseSanctionsScreenPayload(row.proposedPayload);
    if (!payload) return;
    await applySanctionsScreen(row.id, payload);
    return;
  }

  // ---- Phase 7 ------------------------------------------------------------
  if (row.actionType === 'sms.send') {
    const payload = parseSmsSendPayload(row.proposedPayload);
    if (!payload) return;
    await applySmsSend(row.id, payload);
    return;
  }
  if (row.actionType === 'whatsapp.send') {
    const payload = parseWhatsAppSendPayload(row.proposedPayload);
    if (!payload) return;
    await applyWhatsAppSend(row.id, payload);
    return;
  }
  if (row.actionType === 'whatsapp.send_template') {
    const payload = parseWhatsAppSendTemplatePayload(row.proposedPayload);
    if (!payload) return;
    await applyWhatsAppSendTemplate(row.id, payload);
    return;
  }
  if (row.actionType === 'outbound_call') {
    const payload = parseOutboundCallPayload(row.proposedPayload);
    if (!payload) return;
    await applyOutboundCall(row.id, payload);
    return;
  }
  if (row.actionType === 'mission.create') {
    const payload = parseCreateMissionPayload(row.proposedPayload);
    if (!payload) return;
    await applyCreateMission(row.id, payload, { reviewerId });
    return;
  }
}
