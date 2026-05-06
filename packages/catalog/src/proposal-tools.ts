import { z } from 'zod';
import { defineTool } from '@procur/ai';
import type { ActionDescriptorT } from '@procur/ai';
import { insertChatApproval } from './agent-runtime';

/**
 * Chat propose-* tools (vex-into-procur merge Phase 7.6).
 *
 * Each tool takes a subset of an ActionDescriptor variant's payload
 * (with `kind` + `tier` fixed by the tool itself) and inserts an
 * approval row via insertChatApproval. The tool returns the
 * approvalId + a reviewUrl so the chat surface can render a
 * clickable chip linking to /approvals/[id]. The operator reviews
 * the typed payload there and approves; on approve, the matching
 * executor (Phase 3-7) fires inline.
 *
 * Pattern: chat tool ≠ executor. The tool only PROPOSES; the
 * approve button + executor APPLIES. Same separation vex used —
 * keeps the model from auto-firing destructive side effects.
 *
 * Tier values are pinned per the ActionDescriptor union:
 *   T1: tag/untag, set_kind, milestone, follow_up, sanctions.screen
 *   T2: email/sms/whatsapp send, crm creates, contact updates, deal status
 *   T3: outbound_call, lead.close
 */

const ulidString = z
  .string()
  .regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, 'expected ULID');

const e164Phone = z
  .string()
  .regex(/^\+[1-9]\d{7,14}$/, 'phone must be E.164 (e.g. +18324927169)');

/**
 * Tool result shape — read by the chat UI's `<ApprovalActionCard>`
 * to render an inline preview with Approve / Reject buttons (vex's
 * UX pattern). The full ActionDescriptor payload rides through so
 * the card can show a domain-specific preview (email body, deal
 * shape, call goal, etc.) without round-tripping to /approvals.
 */
interface ProposeResult {
  ok: true;
  /** Marker so the chat UI's type guard catches every propose-* tool. */
  kind: 'approval_action';
  approvalId: string;
  actionType: string;
  tier: 'T0' | 'T1' | 'T2' | 'T3';
  reviewUrl: string;
  summary: string;
  /** Full validated ActionDescriptor — the card renders from this. */
  payload: ActionDescriptorT;
}

function chip(action: ActionDescriptorT, summary: string, approvalId: string): ProposeResult {
  return {
    ok: true,
    kind: 'approval_action',
    approvalId,
    actionType: action.kind,
    tier: action.tier as 'T0' | 'T1' | 'T2' | 'T3',
    reviewUrl: `/approvals/${approvalId}`,
    summary,
    payload: action,
  };
}

export const proposeTools = {
  // ==========================================================================
  // Phase 3 — communications
  // ==========================================================================
  propose_email_send: defineTool({
    name: 'propose_email_send',
    description:
      'Queue an outbound email for operator approval. Use when the user asks to send, draft, ' +
      'or reply to an email. The email DOES NOT send until the operator approves it on the /approvals ' +
      'page. Lead your reply with the approval chip you receive back so the operator can click ' +
      'through. NEVER call this for greetings or read-only intent — only when the user has stated a ' +
      'concrete recipient + subject + body.',
    kind: 'write',
    schema: z.object({
      to: z.array(z.string().email()).min(1).max(20),
      subject: z.string().min(1).max(200),
      body: z.string().min(1).max(50_000),
      inReplyTo: z.string().max(500).optional(),
      contactId: ulidString.optional(),
      lang: z.string().length(2).optional(),
      templateName: z.string().min(1).max(120).optional(),
    }),
    handler: async (ctx, input): Promise<ProposeResult> => {
      const action: ActionDescriptorT = {
        kind: 'email.send',
        tier: 'T2',
        to: input.to,
        subject: input.subject,
        body: input.body,
        ...(input.inReplyTo ? { inReplyTo: input.inReplyTo } : {}),
        ...(input.contactId ? { contactId: input.contactId } : {}),
        ...(input.lang ? { lang: input.lang } : {}),
        ...(input.templateName ? { templateName: input.templateName } : {}),
      };
      const row = await insertChatApproval(action, { userId: ctx.userId });
      return chip(
        action,
        `Email to ${input.to.join(', ')}: ${input.subject}`,
        row.id,
      );
    },
  }),

  // ==========================================================================
  // Phase 4 — sales
  // ==========================================================================
  propose_create_company: defineTool({
    name: 'propose_create_company',
    description:
      'Queue a new CRM organization (counterparty company) for operator approval. Use when the ' +
      'user asks to create / add / register a counterparty, supplier, buyer, or broker. The org ' +
      'is NOT created until the operator approves. Always include a rationale paragraph the ' +
      "operator can verify against the user's stated intent.",
    kind: 'write',
    schema: z.object({
      legalName: z.string().min(1).max(200),
      domain: z.string().max(255).optional(),
      industry: z.string().max(120).optional(),
      rationale: z.string().min(1).max(1000),
    }),
    handler: async (ctx, input): Promise<ProposeResult> => {
      const action: ActionDescriptorT = {
        kind: 'crm.create_company',
        tier: 'T2',
        legalName: input.legalName,
        rationale: input.rationale,
        ...(input.domain ? { domain: input.domain } : {}),
        ...(input.industry ? { industry: input.industry } : {}),
      };
      const row = await insertChatApproval(action, { userId: ctx.userId });
      return chip(action, `Create company: ${input.legalName}`, row.id);
    },
  }),

  propose_create_contact: defineTool({
    name: 'propose_create_contact',
    description:
      'Queue a new CRM contact (person at a company) for operator approval. Use when the user ' +
      'asks to add / create a contact, person, or representative. Always link to at least one ' +
      'organization via orgs[]; mark exactly one as isPrimary.',
    kind: 'write',
    schema: z.object({
      fullName: z.string().min(1).max(200),
      title: z.string().max(200).optional(),
      emails: z.array(z.string().email()).max(10).optional(),
      phones: z.array(z.string().max(40)).max(10).optional(),
      orgs: z
        .array(
          z.object({
            orgId: ulidString,
            role: z.string().max(200).optional(),
            isPrimary: z.boolean().optional(),
          }),
        )
        .min(1)
        .max(20),
      rationale: z.string().min(1).max(1000),
    }),
    handler: async (ctx, input): Promise<ProposeResult> => {
      const action: ActionDescriptorT = {
        kind: 'crm.create_contact',
        tier: 'T2',
        fullName: input.fullName,
        orgs: input.orgs,
        rationale: input.rationale,
        ...(input.title ? { title: input.title } : {}),
        ...(input.emails ? { emails: input.emails } : {}),
        ...(input.phones ? { phones: input.phones } : {}),
      };
      const row = await insertChatApproval(action, { userId: ctx.userId });
      return chip(action, `Create contact: ${input.fullName}`, row.id);
    },
  }),

  propose_close_lead: defineTool({
    name: 'propose_close_lead',
    description:
      'Queue a lead-close decision for operator approval (won or lost). T3 — high-impact and ' +
      'should be reviewed one at a time. Always supply a reason.',
    kind: 'write',
    schema: z.object({
      leadId: ulidString,
      outcome: z.enum(['won', 'lost']),
      reason: z.string().min(1).max(500),
    }),
    handler: async (ctx, input): Promise<ProposeResult> => {
      const action: ActionDescriptorT = {
        kind: 'lead.close',
        tier: 'T3',
        leadId: input.leadId,
        outcome: input.outcome,
        reason: input.reason,
      };
      const row = await insertChatApproval(action, { userId: ctx.userId });
      return chip(action, `Close lead as ${input.outcome}`, row.id);
    },
  }),

  propose_schedule_followup: defineTool({
    name: 'propose_schedule_followup',
    description:
      'Queue a deferred reminder for operator approval. Use when the user says "remind me about X ' +
      'next Thursday" or "follow up with Y on Monday". Always include an ISO-8601 UTC dueAt.',
    kind: 'write',
    schema: z.object({
      title: z.string().min(1).max(200),
      note: z.string().max(2000).optional(),
      dueAt: z
        .string()
        .regex(
          /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?Z$/,
          'dueAt must be ISO-8601 UTC (e.g. 2026-04-25T15:00:00Z)',
        ),
      subjectType: z
        .enum(['organization', 'contact', 'deal', 'enrollment', 'campaign'])
        .optional(),
      subjectId: ulidString.optional(),
      assignedTo: z.string().max(200).optional(),
      rationale: z.string().max(500).optional(),
    }),
    handler: async (ctx, input): Promise<ProposeResult> => {
      const action: ActionDescriptorT = {
        kind: 'follow_up.schedule',
        tier: 'T1',
        title: input.title,
        dueAt: input.dueAt,
        ...(input.note ? { note: input.note } : {}),
        ...(input.subjectType ? { subjectType: input.subjectType } : {}),
        ...(input.subjectId ? { subjectId: input.subjectId } : {}),
        ...(input.assignedTo ? { assignedTo: input.assignedTo } : {}),
        ...(input.rationale ? { rationale: input.rationale } : {}),
      };
      const row = await insertChatApproval(action, { userId: ctx.userId });
      return chip(
        action,
        `Follow-up: ${input.title} (due ${input.dueAt})`,
        row.id,
      );
    },
  }),

  // ==========================================================================
  // Phase 5 — deals
  // ==========================================================================
  propose_create_deal: defineTool({
    name: 'propose_create_deal',
    description:
      'Queue a new fuel/food deal for operator approval. Required: dealRef, product, incoterm, ' +
      'pricing basis, payment terms, volume, buyer org. Use when the user describes a fresh deal ' +
      'opportunity in concrete terms. ALWAYS pull buyerOrgId from a prior lookup_known_entities or ' +
      'lookup_known_entities call — never invent it.',
    kind: 'write',
    schema: z.object({
      dealRef: z.string().min(1).max(50),
      lineOfBusiness: z.enum(['fuel', 'food']).default('fuel'),
      product: z.enum([
        'ulsd', 'gasoline_87', 'gasoline_91', 'jet_a', 'jet_a1', 'avgas', 'lfo',
        'hfo', 'lng', 'lpg', 'biodiesel_b20', 'rice', 'beans', 'pork', 'chicken',
        'cooking_oil', 'powdered_milk',
      ]),
      incoterm: z.enum(['fob', 'cif', 'cfr', 'dap', 'exw', 'fas']),
      pricingBasis: z.enum([
        'platts', 'argus', 'opis', 'nymex_wti', 'nymex_rbob', 'ice_brent',
        'fixed', 'negotiated',
      ]),
      paymentTerms: z.enum([
        'prepayment_100', 'prepayment_80_20', 'lc_sight', 'lc_60d', 'lc_90d',
        'lc_120d', 'sblc', 'open_account', 'telegraphic_transfer', 'mixed',
      ]),
      volumeUsg: z.number().positive(),
      volumeUnit: z.enum(['usg', 'mt', 'kg', 'lbs', 'containers']).default('usg'),
      densityKgL: z.number().positive().max(2).optional(),
      buyerOrgId: ulidString,
      destinationPort: z.string().optional(),
      laycanStart: z.string().optional(),
      laycanEnd: z.string().optional(),
      notes: z.string().optional(),
      rationale: z.string().min(1).max(1000),
    }),
    handler: async (ctx, input): Promise<ProposeResult> => {
      const action: ActionDescriptorT = {
        kind: 'crm.create_deal',
        tier: 'T2',
        ...input,
      };
      const row = await insertChatApproval(action, { userId: ctx.userId });
      return chip(
        action,
        `Deal ${input.dealRef}: ${input.product} ${input.volumeUsg.toLocaleString()} ${input.volumeUnit} ${input.incoterm.toUpperCase()}`,
        row.id,
      );
    },
  }),

  propose_deal_status_change: defineTool({
    name: 'propose_deal_status_change',
    description:
      'Queue a fuel-deal status transition for operator approval. Always pass the deal_id ULID ' +
      'pulled from a prior lookup; never invent it.',
    kind: 'write',
    schema: z.object({
      deal_id: ulidString,
      to_status: z.enum([
        'draft', 'negotiating', 'pending_approval', 'approved', 'loading',
        'in_transit', 'delivered', 'settled', 'cancelled', 'failed',
      ]),
      from_status: z.string().optional(),
      rationale: z.string().min(1).max(1000),
    }),
    handler: async (ctx, input): Promise<ProposeResult> => {
      const action: ActionDescriptorT = {
        kind: 'deal.status_change',
        tier: 'T2',
        deal_id: input.deal_id,
        to_status: input.to_status,
        rationale: input.rationale,
        ...(input.from_status ? { from_status: input.from_status } : {}),
      };
      const row = await insertChatApproval(action, { userId: ctx.userId });
      return chip(
        action,
        `Deal ${input.deal_id.slice(0, 8)} → ${input.to_status}`,
        row.id,
      );
    },
  }),

  propose_deal_milestone: defineTool({
    name: 'propose_deal_milestone',
    description:
      'Record a fuel-deal milestone (BL issued, OFAC cleared, cargo loaded, etc.) for operator ' +
      'approval. T1 because milestones are factual logs, not outbound action.',
    kind: 'write',
    schema: z.object({
      dealId: ulidString,
      milestone: z.enum([
        'bis_license_issued', 'ofac_cleared', 'contract_signed', 'prepayment_received',
        'product_purchased', 'production_started', 'fumigation_complete', 'inspection_passed',
        'cargo_loaded', 'vessel_departed', 'bl_issued', 'vessel_arrived',
        'cargo_discharged', 'final_payment_received', 'deal_closed',
      ]),
      occurredAt: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?Z$/)
        .optional(),
      note: z.string().max(2000).optional(),
      rationale: z.string().max(500).optional(),
    }),
    handler: async (ctx, input): Promise<ProposeResult> => {
      const action: ActionDescriptorT = {
        kind: 'deal.milestone',
        tier: 'T1',
        dealId: input.dealId,
        milestone: input.milestone,
        ...(input.occurredAt ? { occurredAt: input.occurredAt } : {}),
        ...(input.note ? { note: input.note } : {}),
        ...(input.rationale ? { rationale: input.rationale } : {}),
      };
      const row = await insertChatApproval(action, { userId: ctx.userId });
      return chip(action, `Milestone: ${input.milestone}`, row.id);
    },
  }),

  // ==========================================================================
  // Phase 6 — sanctions
  // ==========================================================================
  propose_sanctions_screen: defineTool({
    name: 'propose_sanctions_screen',
    description:
      "Queue an OFAC / sanctions screen for an organization. Use when the user says 'screen X', " +
      "'is X sanctioned', 'check OFAC for X'. T1 because the side-effect is reading public lists " +
      'and writing an audit row; the consequential T3 hold (if any) fires only on confirmed match.',
    kind: 'write',
    schema: z.object({
      organizationId: ulidString,
      rationale: z.string().min(1).max(1000),
    }),
    handler: async (ctx, input): Promise<ProposeResult> => {
      const action: ActionDescriptorT = {
        kind: 'sanctions.screen',
        tier: 'T1',
        organizationId: input.organizationId,
        rationale: input.rationale,
      };
      const row = await insertChatApproval(action, { userId: ctx.userId });
      return chip(
        action,
        `Sanctions screen org ${input.organizationId.slice(0, 8)}`,
        row.id,
      );
    },
  }),

  // ==========================================================================
  // Phase 7 — Twilio messaging + voice
  // ==========================================================================
  propose_sms_send: defineTool({
    name: 'propose_sms_send',
    description:
      'Queue an outbound SMS for operator approval. T2 — sends a real text. Use when the user ' +
      'asks to text someone with concrete content.',
    kind: 'write',
    schema: z.object({
      to: e164Phone,
      body: z.string().min(1).max(1_500),
      contactId: ulidString.optional(),
      templateName: z.string().min(1).max(120).optional(),
      rationale: z.string().min(1).max(1000),
    }),
    handler: async (ctx, input): Promise<ProposeResult> => {
      const action: ActionDescriptorT = {
        kind: 'sms.send',
        tier: 'T2',
        to: input.to,
        body: input.body,
        rationale: input.rationale,
        ...(input.contactId ? { contactId: input.contactId } : {}),
        ...(input.templateName ? { templateName: input.templateName } : {}),
      };
      const row = await insertChatApproval(action, { userId: ctx.userId });
      return chip(action, `SMS to ${input.to}`, row.id);
    },
  }),

  propose_whatsapp_send: defineTool({
    name: 'propose_whatsapp_send',
    description:
      'Queue an outbound WhatsApp message for operator approval. Recipient must have messaged ' +
      'you in the last 24h or be addressable via a Twilio Content Template (use ' +
      'propose_whatsapp_send_template for templates).',
    kind: 'write',
    schema: z.object({
      to: e164Phone,
      body: z.string().min(1).max(1_500),
      contactId: ulidString.optional(),
      templateName: z.string().min(1).max(120).optional(),
      rationale: z.string().min(1).max(1000),
    }),
    handler: async (ctx, input): Promise<ProposeResult> => {
      const action: ActionDescriptorT = {
        kind: 'whatsapp.send',
        tier: 'T2',
        to: input.to,
        body: input.body,
        rationale: input.rationale,
        ...(input.contactId ? { contactId: input.contactId } : {}),
        ...(input.templateName ? { templateName: input.templateName } : {}),
      };
      const row = await insertChatApproval(action, { userId: ctx.userId });
      return chip(action, `WhatsApp to ${input.to}`, row.id);
    },
  }),

  propose_outbound_call: defineTool({
    name: 'propose_outbound_call',
    description:
      'Queue a Twilio outbound voice call for operator approval. T3 — the highest tier. Two ' +
      "modes: aiMode=false (default) joins the recipient + operator in a Twilio conference; " +
      'aiMode=true connects to procur-voice-bridge for full AI talkback. When aiMode=true, ' +
      'aiInstructions becomes the system prompt for the AI conversation. Always include goalHint ' +
      'so the operator-review chip shows what the call is trying to accomplish.',
    kind: 'write',
    schema: z.object({
      contactId: ulidString,
      orgId: ulidString,
      toNumber: e164Phone,
      aiMode: z.boolean().optional(),
      aiInstructions: z.string().min(1).max(5000).optional(),
      templateName: z.string().min(1).max(120).optional(),
      goalHint: z.string().min(1).max(280).optional(),
      rationale: z.string().min(1).max(1000),
    }),
    handler: async (ctx, input): Promise<ProposeResult> => {
      const action: ActionDescriptorT = {
        kind: 'outbound_call',
        tier: 'T3',
        contactId: input.contactId,
        orgId: input.orgId,
        toNumber: input.toNumber,
        rationale: input.rationale,
        ...(input.aiMode !== undefined ? { aiMode: input.aiMode } : {}),
        ...(input.aiInstructions ? { aiInstructions: input.aiInstructions } : {}),
        ...(input.templateName ? { templateName: input.templateName } : {}),
        ...(input.goalHint ? { goalHint: input.goalHint } : {}),
      };
      const row = await insertChatApproval(action, { userId: ctx.userId });
      return chip(
        action,
        `Call ${input.toNumber}${input.aiMode ? ' (AI)' : ''}: ${input.goalHint ?? input.rationale.slice(0, 80)}`,
        row.id,
      );
    },
  }),
};
