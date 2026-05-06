import { z } from 'zod';
import { ApprovalTier, requiresApproval } from './approval-tier';
import { isUlid } from './id';

const zUlid = z.string().refine(isUlid, { message: 'expected ULID' });

/**
 * Typed descriptor for an action an agent wants to take. The descriptor is
 * stored verbatim on `approvals.proposed_payload` so reviewers see exactly
 * what they're approving — no free-form strings or raw tool-call blobs.
 *
 * Ported from vex's @vex/agents action.ts (vex-into-procur merge Phase 2).
 * Kept as a discriminated union so adding a new action kind anywhere in
 * the codebase produces a compile error at every consumer.
 */
export const ActionDescriptor = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('email.send'),
    tier: z.literal(ApprovalTier.T2),
    to: z.array(z.string().email()).min(1),
    subject: z.string().min(1),
    body: z.string().min(1),
    inReplyTo: z.string().max(500).optional(),
    contactId: zUlid.optional(),
    /** ISO 639-1 — display-only language tag for the chip preview. */
    lang: z.string().length(2).optional(),
    /** Registered-template name for chip preview. Empty = freeform send. */
    templateName: z.string().min(1).max(120).optional(),
  }),
  z.object({
    kind: z.literal('crm.note'),
    tier: z.literal(ApprovalTier.T1),
    organizationId: zUlid,
    body: z.string().min(1),
  }),
  z.object({
    kind: z.literal('lead.close'),
    tier: z.literal(ApprovalTier.T3),
    leadId: zUlid,
    outcome: z.enum(['won', 'lost']),
    reason: z.string().min(1),
  }),
  z.object({
    kind: z.literal('crm.create_company'),
    tier: z.literal(ApprovalTier.T2),
    legalName: z.string().min(1).max(200),
    domain: z.string().max(255).optional(),
    industry: z.string().max(120).optional(),
    rationale: z.string().min(1).max(1000),
  }),
  z.object({
    kind: z.literal('crm.create_contact'),
    tier: z.literal(ApprovalTier.T2),
    fullName: z.string().min(1).max(200),
    title: z.string().max(200).optional(),
    emails: z.array(z.string().email()).max(10).optional(),
    phones: z.array(z.string().max(40)).max(10).optional(),
    orgs: z
      .array(
        z.object({
          orgId: zUlid,
          role: z.string().max(200).optional(),
          isPrimary: z.boolean().optional(),
        }),
      )
      .min(1)
      .max(20),
    rationale: z.string().min(1).max(1000),
  }),
  z.object({
    kind: z.literal('crm.create_deal'),
    tier: z.literal(ApprovalTier.T2),
    dealRef: z.string().min(1).max(50),
    lineOfBusiness: z.enum(['fuel', 'food']).default('fuel'),
    product: z.enum([
      'ulsd',
      'gasoline_87',
      'gasoline_91',
      'jet_a',
      'jet_a1',
      'avgas',
      'lfo',
      'hfo',
      'lng',
      'lpg',
      'biodiesel_b20',
      'rice',
      'beans',
      'pork',
      'chicken',
      'cooking_oil',
      'powdered_milk',
    ]),
    incoterm: z.enum(['fob', 'cif', 'cfr', 'dap', 'exw', 'fas']),
    pricingBasis: z.enum([
      'platts',
      'argus',
      'opis',
      'nymex_wti',
      'nymex_rbob',
      'ice_brent',
      'fixed',
      'negotiated',
    ]),
    paymentTerms: z.enum([
      'prepayment_100',
      'prepayment_80_20',
      'lc_sight',
      'lc_60d',
      'lc_90d',
      'lc_120d',
      'sblc',
      'open_account',
      'telegraphic_transfer',
      'mixed',
    ]),
    volumeUsg: z.number().positive(),
    volumeUnit: z
      .enum(['usg', 'mt', 'kg', 'lbs', 'containers'])
      .default('usg'),
    densityKgL: z.number().positive().max(2).optional(),
    productionLeadTimeWeeks: z.number().int().min(0).max(52).optional(),
    coldChainRequired: z.boolean().optional(),
    buyerOrgId: zUlid,
    destinationPort: z.string().optional(),
    laycanStart: z.string().optional(),
    laycanEnd: z.string().optional(),
    notes: z.string().optional(),
    rationale: z.string().min(1).max(1000),
  }),
  z.object({
    kind: z.literal('campaign.enroll_batch'),
    tier: z.literal(ApprovalTier.T2),
    campaignId: zUlid,
    contactIds: z.array(zUlid).min(1).max(500),
    rationale: z.string().min(1).max(1000),
  }),
  z.object({
    kind: z.literal('contact.update'),
    tier: z.literal(ApprovalTier.T2),
    contactId: zUlid,
    patch: z
      .object({
        fullName: z.string().min(1).max(200).optional(),
        title: z.string().max(200).nullable().optional(),
        emails: z.array(z.string().email()).max(20).optional(),
        phones: z
          .array(
            z
              .string()
              .regex(
                /^\+[1-9]\d{7,14}$/,
                'phones must be E.164 (e.g. +18324927169)',
              ),
          )
          .max(20)
          .optional(),
        timezone: z.string().max(100).nullable().optional(),
        tags: z.array(z.string().min(1).max(64)).max(40).optional(),
      })
      .refine((p) => Object.keys(p).length > 0, {
        message: 'patch must have at least one field',
      }),
    rationale: z.string().min(1).max(1000),
  }),
  z.object({
    kind: z.literal('contact.merge'),
    tier: z.literal(ApprovalTier.T2),
    sourceContactId: zUlid,
    targetContactId: zUlid,
    rationale: z.string().min(1).max(1000),
  }),
  z.object({
    kind: z.literal('contact.enrich'),
    tier: z.literal(ApprovalTier.T1),
    contactId: zUlid,
    rationale: z.string().min(1).max(1000),
  }),
  z.object({
    kind: z.literal('sanctions.screen'),
    tier: z.literal(ApprovalTier.T1),
    organizationId: zUlid,
    rationale: z.string().min(1).max(1000),
  }),
  z.object({
    kind: z.literal('contact.add_membership'),
    tier: z.literal(ApprovalTier.T1),
    contactId: zUlid,
    organizationId: zUlid,
    role: z.string().max(200).optional(),
    isPrimary: z.boolean().optional(),
    rationale: z.string().min(1).max(1000),
  }),
  z.object({
    kind: z.literal('campaign.create'),
    tier: z.literal(ApprovalTier.T2),
    name: z.string().min(1).max(200),
    channel: z.enum(['email', 'sms', 'whatsapp', 'voice', 'multi']),
    objective: z.string().max(500).optional(),
    steps: z
      .array(
        z
          .object({
            position: z.number().int().min(0).max(50),
            channel: z.enum([
              'email',
              'sms',
              'whatsapp',
              'voice',
              'manual',
            ]),
            delayAfterPriorMs: z
              .number()
              .int()
              .min(0)
              .max(90 * 24 * 3600_000),
            tier: z.enum(['T0', 'T1', 'T2', 'T3']),
            autoApprove: z.boolean(),
            templateRef: z.string().max(200).optional().nullable(),
            subjectOverride: z.string().max(500).optional().nullable(),
            bodyOverride: z.string().max(50_000).optional().nullable(),
            gateConditionJson: z.record(z.unknown()).optional(),
          })
          .superRefine((step, ctx) => {
            if (step.channel === 'manual') return;
            const hasTemplate =
              typeof step.templateRef === 'string' &&
              step.templateRef.length > 0;
            const hasBody =
              typeof step.bodyOverride === 'string' &&
              step.bodyOverride.length > 0;
            if (!hasTemplate && !hasBody) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message:
                  'step must set either templateRef (registered template) or bodyOverride (inline content)',
              });
              return;
            }
            if (hasTemplate && hasBody) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message:
                  'step cannot set both templateRef and bodyOverride — pick one',
              });
              return;
            }
            if (step.channel === 'email' && hasBody) {
              const hasSubject =
                typeof step.subjectOverride === 'string' &&
                step.subjectOverride.length > 0;
              if (!hasSubject) {
                ctx.addIssue({
                  code: z.ZodIssueCode.custom,
                  message:
                    'untemplated email step requires both subjectOverride and bodyOverride',
                });
              }
            }
          }),
      )
      .min(1)
      .max(20),
    rationale: z.string().min(1).max(1000),
  }),
  z.object({
    kind: z.literal('sms.send'),
    tier: z.literal(ApprovalTier.T2),
    to: z
      .string()
      .regex(/^\+[1-9]\d{7,14}$/, 'to must be E.164 (e.g. +18324927169)'),
    body: z.string().min(1).max(1_500),
    contactId: zUlid.optional(),
    templateName: z.string().min(1).max(120).optional(),
    rationale: z.string().min(1).max(1000),
  }),
  z.object({
    kind: z.literal('whatsapp.send'),
    tier: z.literal(ApprovalTier.T2),
    to: z
      .string()
      .regex(/^\+[1-9]\d{7,14}$/, 'to must be E.164 (e.g. +18324927169)'),
    body: z.string().min(1).max(1_500),
    contactId: zUlid.optional(),
    templateName: z.string().min(1).max(120).optional(),
    rationale: z.string().min(1).max(1000),
  }),
  z.object({
    kind: z.literal('whatsapp.send_template'),
    tier: z.literal(ApprovalTier.T2),
    to: z
      .string()
      .regex(/^\+[1-9]\d{7,14}$/, 'to must be E.164 (e.g. +18324927169)'),
    contentSid: z
      .string()
      .regex(/^HX[a-fA-F0-9]{32}$/, 'contentSid must be HX + 32 hex chars'),
    contentVariables: z.record(z.string(), z.string()).optional(),
    templateName: z.string().min(1).max(120).optional(),
    contactId: zUlid.optional(),
    rationale: z.string().min(1).max(1000),
  }),
  z.object({
    kind: z.literal('deal.status_change'),
    tier: z.literal(ApprovalTier.T2),
    deal_id: zUlid,
    to_status: z.enum([
      'draft',
      'negotiating',
      'pending_approval',
      'approved',
      'loading',
      'in_transit',
      'delivered',
      'settled',
      'cancelled',
      'failed',
    ]),
    from_status: z.string().optional(),
    rationale: z.string().min(1).max(1000),
  }),
  z.object({
    kind: z.literal('contact.opt_out'),
    tier: z.literal(ApprovalTier.T2),
    contactId: zUlid,
    reason: z.string().min(1).max(500),
  }),
  z.object({
    kind: z.literal('outbound_call'),
    tier: z.literal(ApprovalTier.T3),
    contactId: zUlid,
    orgId: zUlid,
    toNumber: z
      .string()
      .regex(
        /^\+[1-9]\d{7,14}$/,
        'toNumber must be E.164 (e.g. +18324927169)',
      ),
    aiMode: z.boolean().optional(),
    aiInstructions: z.string().min(1).max(5000).optional(),
    templateName: z.string().min(1).max(120).optional(),
    goalHint: z.string().min(1).max(280).optional(),
    rationale: z.string().min(1).max(1000),
  }),
  z.object({
    kind: z.literal('enrollment.control'),
    tier: z.literal(ApprovalTier.T2),
    enrollmentId: zUlid,
    action: z.enum(['pause', 'resume', 'unsubscribe']),
    note: z.string().max(500).optional(),
    rationale: z.string().min(1).max(1000),
  }),
  z.object({
    kind: z.literal('org.tag'),
    tier: z.literal(ApprovalTier.T1),
    orgId: zUlid,
    tag: z.string().min(1).max(64),
    rationale: z.string().max(500).optional(),
  }),
  z.object({
    kind: z.literal('org.untag'),
    tier: z.literal(ApprovalTier.T1),
    orgId: zUlid,
    tag: z.string().min(1).max(64),
    rationale: z.string().max(500).optional(),
  }),
  z.object({
    kind: z.literal('contact.tag'),
    tier: z.literal(ApprovalTier.T1),
    contactId: zUlid,
    tag: z.string().min(1).max(64),
    rationale: z.string().max(500).optional(),
  }),
  z.object({
    kind: z.literal('contact.untag'),
    tier: z.literal(ApprovalTier.T1),
    contactId: zUlid,
    tag: z.string().min(1).max(64),
    rationale: z.string().max(500).optional(),
  }),
  z.object({
    kind: z.literal('follow_up.schedule'),
    tier: z.literal(ApprovalTier.T1),
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
    subjectId: zUlid.optional(),
    assignedTo: z.string().max(200).optional(),
    rationale: z.string().max(500).optional(),
  }),
  z.object({
    kind: z.literal('deal.milestone'),
    tier: z.literal(ApprovalTier.T1),
    dealId: zUlid,
    milestone: z.enum([
      'bis_license_issued',
      'ofac_cleared',
      'contract_signed',
      'prepayment_received',
      'product_purchased',
      'production_started',
      'fumigation_complete',
      'inspection_passed',
      'cargo_loaded',
      'vessel_departed',
      'bl_issued',
      'vessel_arrived',
      'cargo_discharged',
      'final_payment_received',
      'deal_closed',
    ]),
    occurredAt: z
      .string()
      .regex(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?Z$/,
        'occurredAt must be ISO-8601 UTC (e.g. 2026-04-25T15:00:00Z)',
      )
      .optional(),
    note: z.string().max(2000).optional(),
    rationale: z.string().max(500).optional(),
  }),
  z.object({
    kind: z.literal('unsupported_request'),
    tier: z.literal(ApprovalTier.T1),
    originalCommand: z.string().min(1).max(2000),
    reason: z.string().min(1).max(500),
    suggestion: z.string().max(500).optional(),
  }),
  z.object({
    kind: z.literal('org.set_kind'),
    tier: z.literal(ApprovalTier.T1),
    orgId: zUlid,
    orgKind: z.enum([
      'buyer',
      'supplier',
      'broker',
      'buyer_broker',
      'internal',
      'competitor',
    ]),
    rationale: z.string().max(500).optional(),
  }),
  z.object({
    kind: z.literal('org.add_product'),
    tier: z.literal(ApprovalTier.T1),
    orgId: zUlid,
    product: z.enum([
      'ulsd',
      'gasoline_87',
      'gasoline_91',
      'jet_a',
      'jet_a1',
      'avgas',
      'lfo',
      'hfo',
      'lng',
      'lpg',
      'biodiesel_b20',
      'rice',
      'beans',
      'pork',
      'chicken',
      'cooking_oil',
      'powdered_milk',
    ]),
    notes: z.string().max(1000).optional(),
    rationale: z.string().max(500).optional(),
  }),
  z.object({
    kind: z.literal('org.link_relationship'),
    tier: z.literal(ApprovalTier.T1),
    fromOrgId: zUlid,
    toOrgId: zUlid,
    relationshipType: z.enum([
      'brokers_for',
      'sources_from',
      'partners_with',
      'subsidiary_of',
    ]),
    product: z
      .enum([
        'ulsd',
        'gasoline_87',
        'gasoline_91',
        'jet_a',
        'jet_a1',
        'avgas',
        'lfo',
        'hfo',
        'lng',
        'lpg',
        'biodiesel_b20',
        'rice',
        'beans',
        'pork',
        'chicken',
        'cooking_oil',
        'powdered_milk',
      ])
      .optional(),
    notes: z.string().max(1000).optional(),
    rationale: z.string().max(500).optional(),
  }),
  z.object({
    kind: z.literal('org.update_fields'),
    tier: z.literal(ApprovalTier.T1),
    orgId: zUlid,
    patch: z
      .object({
        domain: z.string().max(200).nullable().optional(),
        industry: z.string().max(200).nullable().optional(),
        country: z.string().length(2).nullable().optional(),
      })
      .refine(
        (p) =>
          p.domain !== undefined ||
          p.industry !== undefined ||
          p.country !== undefined,
        { message: 'patch must include at least one field' },
      ),
    rationale: z.string().max(500).optional(),
  }),
  z.object({
    kind: z.literal('deal.set_broker'),
    tier: z.literal(ApprovalTier.T2),
    dealId: zUlid,
    side: z.enum(['buy', 'sell']),
    brokerOrgId: zUlid,
    commissionPct: z.number().min(0).max(1).optional(),
    paymentTerms: z.string().max(500).optional(),
    rationale: z.string().max(500).optional(),
  }),
  z.object({
    kind: z.literal('lead.reactivate_draft'),
    tier: z.literal(ApprovalTier.T2),
    contactIds: z.array(zUlid).min(1).max(20),
    productContext: z.string().min(1).max(500),
    angle: z.string().min(1).max(500).optional(),
    rationale: z.string().min(1).max(1000),
  }),
  z.object({
    kind: z.literal('touchpoint.log'),
    tier: z.literal(ApprovalTier.T1),
    contactId: zUlid.optional(),
    orgId: zUlid.optional(),
    dealId: zUlid.optional(),
    channel: z.enum([
      'voice.manual',
      'meeting',
      'chat.manual',
      'email.manual',
      'other',
    ]),
    direction: z.enum(['inbound', 'outbound']).optional(),
    occurredAt: z.string().datetime().optional(),
    note: z.string().min(1).max(2000),
    rationale: z.string().max(500).optional(),
  }),
  /**
   * Bundle wraps N sub-actions the operator reviews + decides per-item.
   * Items are stored as raw JSONB (not re-validated as ActionDescriptors
   * inside Zod because discriminatedUnion can't self-reference). Each
   * item is independently validated + dispatched by the executor at apply
   * time. Tier is the max tier across items — a bundle containing any T3
   * can't auto-approve.
   */
  z.object({
    kind: z.literal('bundle'),
    tier: z.enum([
      ApprovalTier.T0,
      ApprovalTier.T1,
      ApprovalTier.T2,
      ApprovalTier.T3,
    ]),
    items: z
      .array(
        z
          .object({
            kind: z.string().min(1),
            tier: z.enum([
              ApprovalTier.T0,
              ApprovalTier.T1,
              ApprovalTier.T2,
              ApprovalTier.T3,
            ]),
            payload: z.record(z.unknown()).optional(),
            rationale: z.string().optional(),
          })
          .passthrough(),
      )
      .min(2)
      .max(20),
    rationale: z.string().min(1).max(1000),
  }),
]);

export type ActionDescriptorT = z.infer<typeof ActionDescriptor>;

/**
 * Returns true iff executing the action requires a decided-approved
 * approval row. The tier is captured on the descriptor itself so it
 * can't drift from the action shape.
 */
export function actionRequiresApproval(action: ActionDescriptorT): boolean {
  return requiresApproval(action.tier);
}
