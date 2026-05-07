import { eq } from 'drizzle-orm';
import {
  approvals,
  db,
  events,
  fuelDealCostStack,
  fuelDealScenarios,
  fuelDeals,
} from '@procur/db';
import { createId } from '../agents/id';
import { AgentRunner } from '../agents/agent-runner';
import { DealEvaluatorAgent } from '../agents/agents/deal-evaluator';
import { PostgresCostLedger } from '../cost-ledger';

/**
 * Per-action executors for Phase 5 fuel-deal surfaces. Same pattern as
 * Phase 4 sales executors: each function is idempotent on the approval
 * id (short-circuits if applied_at is set), writes its rows, stamps
 * applied_object_id + applied_at, emits a typed audit event.
 *
 * Wired into apps/app/app/approvals/actions.ts → approveApprovalAction.
 */

interface ExecutorResult {
  ok: boolean;
  appliedObjectId?: string;
  error?: string;
}

async function alreadyApplied(approvalId: string): Promise<boolean> {
  const rows = await db
    .select({ appliedAt: approvals.appliedAt })
    .from(approvals)
    .where(eq(approvals.id, approvalId))
    .limit(1);
  return rows[0]?.appliedAt != null;
}

async function stampApplied(
  approvalId: string,
  appliedObjectId: string,
  verb: string,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  const occurredAt = new Date();
  await db
    .update(approvals)
    .set({ appliedObjectId, appliedAt: occurredAt })
    .where(eq(approvals.id, approvalId));
  await db
    .insert(events)
    .values({
      id: createId(),
      verb,
      subjectType: 'approval',
      subjectId: approvalId,
      actorType: 'system',
      actorId: 'deals-executor',
      objectType: verb.split('.')[0] ?? 'object',
      objectId: appliedObjectId,
      occurredAt,
      idempotencyKey: `${verb}:${approvalId}`,
      metadata,
    })
    .onConflictDoNothing({
      target: [events.occurredAt, events.idempotencyKey],
    });
}

// ============================================================================
// crm.create_deal
// ============================================================================

const FUEL_PRODUCT_TYPES = new Set([
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
]);
const INCOTERMS = new Set(['fob', 'cif', 'cfr', 'dap', 'exw', 'fas']);
const PRICING_BASES = new Set([
  'platts',
  'argus',
  'opis',
  'nymex_wti',
  'nymex_rbob',
  'ice_brent',
  'fixed',
  'negotiated',
]);
const PAYMENT_TERMS = new Set([
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
]);

type DealInsert = typeof fuelDeals.$inferInsert;
type FuelProduct = DealInsert['product'];
type FuelIncoterm = DealInsert['incoterm'];
type FuelPricingBasis = DealInsert['pricingBasis'];
type FuelPaymentTerms = DealInsert['paymentTerms'];

export interface CreateDealPayload {
  dealRef: string;
  lineOfBusiness: 'fuel' | 'food';
  product: string;
  incoterm: string;
  pricingBasis: string;
  paymentTerms: string;
  volumeUsg: number;
  volumeUnit: string;
  densityKgL?: number;
  productionLeadTimeWeeks?: number;
  coldChainRequired?: boolean;
  buyerOrgId: string;
  destinationPort?: string;
  laycanStart?: string;
  laycanEnd?: string;
  notes?: string;
  rationale: string;
}

export function parseCreateDealPayload(
  proposedPayload: Record<string, unknown> | null | undefined,
): CreateDealPayload | null {
  if (!proposedPayload || typeof proposedPayload !== 'object') return null;
  const dealRef = proposedPayload['dealRef'];
  const product = proposedPayload['product'];
  const incoterm = proposedPayload['incoterm'];
  const pricingBasis = proposedPayload['pricingBasis'];
  const paymentTerms = proposedPayload['paymentTerms'];
  const volumeUsg = proposedPayload['volumeUsg'];
  const buyerOrgId = proposedPayload['buyerOrgId'];
  const rationale = proposedPayload['rationale'];
  if (
    typeof dealRef !== 'string' ||
    typeof product !== 'string' ||
    !FUEL_PRODUCT_TYPES.has(product) ||
    typeof incoterm !== 'string' ||
    !INCOTERMS.has(incoterm) ||
    typeof pricingBasis !== 'string' ||
    !PRICING_BASES.has(pricingBasis) ||
    typeof paymentTerms !== 'string' ||
    !PAYMENT_TERMS.has(paymentTerms) ||
    typeof volumeUsg !== 'number' ||
    typeof buyerOrgId !== 'string' ||
    typeof rationale !== 'string'
  ) {
    return null;
  }
  const out: CreateDealPayload = {
    dealRef,
    lineOfBusiness:
      proposedPayload['lineOfBusiness'] === 'food' ? 'food' : 'fuel',
    product,
    incoterm,
    pricingBasis,
    paymentTerms,
    volumeUsg,
    volumeUnit:
      typeof proposedPayload['volumeUnit'] === 'string'
        ? (proposedPayload['volumeUnit'] as string)
        : 'usg',
    buyerOrgId,
    rationale,
  };
  if (typeof proposedPayload['densityKgL'] === 'number') {
    out.densityKgL = proposedPayload['densityKgL'] as number;
  }
  if (typeof proposedPayload['productionLeadTimeWeeks'] === 'number') {
    out.productionLeadTimeWeeks = proposedPayload[
      'productionLeadTimeWeeks'
    ] as number;
  }
  if (typeof proposedPayload['coldChainRequired'] === 'boolean') {
    out.coldChainRequired = proposedPayload['coldChainRequired'] as boolean;
  }
  if (typeof proposedPayload['destinationPort'] === 'string') {
    out.destinationPort = proposedPayload['destinationPort'] as string;
  }
  if (typeof proposedPayload['laycanStart'] === 'string') {
    out.laycanStart = proposedPayload['laycanStart'] as string;
  }
  if (typeof proposedPayload['laycanEnd'] === 'string') {
    out.laycanEnd = proposedPayload['laycanEnd'] as string;
  }
  if (typeof proposedPayload['notes'] === 'string') {
    out.notes = proposedPayload['notes'] as string;
  }
  return out;
}

/**
 * Apply a `crm.create_deal` approval. Creates a fuel_deals row + a
 * stub fuel_deal_cost_stack row + a base fuel_deal_scenarios row
 * marked active with sell_price_per_usg = 0 (operator fills in later).
 * The DealEvaluatorAgent can then run against the deal once cost
 * stack values are populated.
 */
export async function applyCreateDeal(
  approvalId: string,
  payload: CreateDealPayload,
  reviewerId: string | null,
): Promise<ExecutorResult> {
  if (await alreadyApplied(approvalId)) return { ok: true };
  const dealId = createId();

  await db.insert(fuelDeals).values({
    id: dealId,
    dealRef: payload.dealRef,
    status: 'draft',
    dealType: 'spot',
    product: payload.product as FuelProduct,
    incoterm: payload.incoterm as FuelIncoterm,
    pricingBasis: payload.pricingBasis as FuelPricingBasis,
    paymentTerms: payload.paymentTerms as FuelPaymentTerms,
    volumeUsg: payload.volumeUsg,
    densityKgL: payload.densityKgL ?? null,
    lineOfBusiness: payload.lineOfBusiness,
    volumeUnit: payload.volumeUnit,
    productionLeadTimeWeeks: payload.productionLeadTimeWeeks ?? null,
    coldChainRequired: payload.coldChainRequired ?? false,
    buyerOrgId: payload.buyerOrgId,
    destinationPort: payload.destinationPort ?? null,
    laycanStart: payload.laycanStart ?? null,
    laycanEnd: payload.laycanEnd ?? null,
    notes: payload.notes ?? null,
    createdBy: reviewerId,
  });

  // Stub cost stack — operator fills in line items via the deal-edit
  // UI (Phase 5 ships read-only; editing UI is a follow-up). All
  // doublePrecision NOT NULL columns default to 0.
  await db.insert(fuelDealCostStack).values({
    id: createId(),
    dealId,
    productCostPerUsg: 0,
  });

  // Base scenario — sell_price_per_usg starts at 0; operator updates
  // it before running the evaluator. Marked active.
  await db.insert(fuelDealScenarios).values({
    id: createId(),
    dealId,
    scenarioName: 'base',
    scenarioType: 'base',
    isActive: true,
    sellPricePerUsg: 0,
  });

  await stampApplied(approvalId, dealId, 'fuel_deal.created', {
    deal_ref: payload.dealRef,
    product: payload.product,
    line_of_business: payload.lineOfBusiness,
  });
  return { ok: true, appliedObjectId: dealId };
}

// ============================================================================
// deal.status_change
// ============================================================================

const VALID_STATUSES = new Set([
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
]);

type DealStatus = DealInsert['status'];

export interface DealStatusChangePayload {
  dealId: string;
  toStatus: string;
  fromStatus?: string;
  rationale: string;
}

export function parseDealStatusChangePayload(
  proposedPayload: Record<string, unknown> | null | undefined,
): DealStatusChangePayload | null {
  if (!proposedPayload || typeof proposedPayload !== 'object') return null;
  const dealId = proposedPayload['deal_id'] ?? proposedPayload['dealId'];
  const toStatus =
    proposedPayload['to_status'] ?? proposedPayload['toStatus'];
  const rationale = proposedPayload['rationale'];
  if (
    typeof dealId !== 'string' ||
    typeof toStatus !== 'string' ||
    !VALID_STATUSES.has(toStatus) ||
    typeof rationale !== 'string'
  ) {
    return null;
  }
  const out: DealStatusChangePayload = {
    dealId,
    toStatus,
    rationale,
  };
  const fromStatus =
    proposedPayload['from_status'] ?? proposedPayload['fromStatus'];
  if (typeof fromStatus === 'string') out.fromStatus = fromStatus;
  return out;
}

export async function applyDealStatusChange(
  approvalId: string,
  payload: DealStatusChangePayload,
): Promise<ExecutorResult> {
  if (await alreadyApplied(approvalId)) return { ok: true };
  await db
    .update(fuelDeals)
    .set({ status: payload.toStatus as DealStatus, updatedAt: new Date() })
    .where(eq(fuelDeals.id, payload.dealId));
  await stampApplied(approvalId, payload.dealId, 'fuel_deal.status_changed', {
    to_status: payload.toStatus,
    from_status: payload.fromStatus ?? null,
    rationale: payload.rationale,
  });
  return { ok: true, appliedObjectId: payload.dealId };
}

// ============================================================================
// deal.milestone
// ============================================================================

const VALID_MILESTONES = new Set([
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
]);

export interface DealMilestonePayload {
  dealId: string;
  milestone: string;
  occurredAt?: string;
  note?: string;
}

export function parseDealMilestonePayload(
  proposedPayload: Record<string, unknown> | null | undefined,
): DealMilestonePayload | null {
  if (!proposedPayload || typeof proposedPayload !== 'object') return null;
  const dealId = proposedPayload['dealId'];
  const milestone = proposedPayload['milestone'];
  if (
    typeof dealId !== 'string' ||
    typeof milestone !== 'string' ||
    !VALID_MILESTONES.has(milestone)
  ) {
    return null;
  }
  const out: DealMilestonePayload = { dealId, milestone };
  if (typeof proposedPayload['occurredAt'] === 'string') {
    out.occurredAt = proposedPayload['occurredAt'] as string;
  }
  if (typeof proposedPayload['note'] === 'string') {
    out.note = proposedPayload['note'] as string;
  }
  return out;
}

/**
 * Record a deal milestone. The milestone itself lives on the events
 * table (subjectType='fuel_deal', verb='deal.milestone.<name>') —
 * we don't add a separate milestones table because vex's pattern
 * (and procur's events table) already gives us a typed timeline
 * with idempotency.
 */
export async function applyDealMilestone(
  approvalId: string,
  payload: DealMilestonePayload,
): Promise<ExecutorResult> {
  if (await alreadyApplied(approvalId)) return { ok: true };
  const occurredAt = payload.occurredAt
    ? new Date(payload.occurredAt)
    : new Date();
  // Stamp the milestone event directly on the deal (separate from
  // the approval audit event).
  await db
    .insert(events)
    .values({
      id: createId(),
      verb: `deal.milestone.${payload.milestone}`,
      subjectType: 'fuel_deal',
      subjectId: payload.dealId,
      actorType: 'system',
      actorId: 'deals-executor',
      objectType: 'milestone',
      objectId: payload.milestone,
      occurredAt,
      idempotencyKey: `deal.milestone.${payload.milestone}:${payload.dealId}:${occurredAt.toISOString()}`,
      metadata: {
        note: payload.note ?? null,
      },
    })
    .onConflictDoNothing({
      target: [events.occurredAt, events.idempotencyKey],
    });
  await stampApplied(approvalId, payload.dealId, 'fuel_deal.milestone_recorded', {
    milestone: payload.milestone,
  });
  return { ok: true, appliedObjectId: payload.dealId };
}

// ============================================================================
// deal.set_broker
// ============================================================================

export interface DealSetBrokerPayload {
  dealId: string;
  side: 'buy' | 'sell';
  brokerOrgId: string;
  commissionPct?: number;
  paymentTerms?: string;
}

export function parseDealSetBrokerPayload(
  proposedPayload: Record<string, unknown> | null | undefined,
): DealSetBrokerPayload | null {
  if (!proposedPayload || typeof proposedPayload !== 'object') return null;
  const dealId = proposedPayload['dealId'];
  const side = proposedPayload['side'];
  const brokerOrgId = proposedPayload['brokerOrgId'];
  if (
    typeof dealId !== 'string' ||
    (side !== 'buy' && side !== 'sell') ||
    typeof brokerOrgId !== 'string'
  ) {
    return null;
  }
  const out: DealSetBrokerPayload = {
    dealId,
    side: side as 'buy' | 'sell',
    brokerOrgId,
  };
  if (typeof proposedPayload['commissionPct'] === 'number') {
    out.commissionPct = proposedPayload['commissionPct'] as number;
  }
  if (typeof proposedPayload['paymentTerms'] === 'string') {
    out.paymentTerms = proposedPayload['paymentTerms'] as string;
  }
  return out;
}

export async function applyDealSetBroker(
  approvalId: string,
  payload: DealSetBrokerPayload,
): Promise<ExecutorResult> {
  if (await alreadyApplied(approvalId)) return { ok: true };
  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (payload.side === 'buy') {
    updates['buySideBrokerOrgId'] = payload.brokerOrgId;
    if (payload.commissionPct !== undefined) {
      updates['buySideBrokerCommissionPct'] = payload.commissionPct;
    }
    if (payload.paymentTerms !== undefined) {
      updates['buySideBrokerPaymentTerms'] = payload.paymentTerms;
    }
  } else {
    updates['sellSideBrokerOrgId'] = payload.brokerOrgId;
    if (payload.commissionPct !== undefined) {
      updates['sellSideBrokerCommissionPct'] = payload.commissionPct;
    }
    if (payload.paymentTerms !== undefined) {
      updates['sellSideBrokerPaymentTerms'] = payload.paymentTerms;
    }
  }
  await db.update(fuelDeals).set(updates).where(eq(fuelDeals.id, payload.dealId));
  await stampApplied(approvalId, payload.dealId, 'fuel_deal.broker_set', {
    side: payload.side,
    broker_org_id: payload.brokerOrgId,
    commission_pct: payload.commissionPct ?? null,
  });
  return { ok: true, appliedObjectId: payload.dealId };
}

// ============================================================================
// deal.human_review
// ============================================================================

/**
 * `deal.human_review` is a sign-off action — the operator acknowledges
 * the calculator's `do_not_proceed` verdict. The executor doesn't
 * apply a mechanical side-effect (no status change, no row write
 * beyond the audit trail) because the right next step varies per
 * deal: sometimes operator wants to renegotiate, sometimes flip to
 * 'failed', sometimes override the verdict. Approving stamps the
 * approval as applied so the queue clears; the operator follows up
 * with a separate `deal.status_change` if appropriate.
 */
export async function applyDealHumanReview(
  approvalId: string,
  dealId: string,
): Promise<ExecutorResult> {
  if (await alreadyApplied(approvalId)) return { ok: true };
  await stampApplied(approvalId, dealId, 'fuel_deal.human_review_acknowledged');
  return { ok: true, appliedObjectId: dealId };
}

// ============================================================================
// deal.evaluate — chat-driven invocation of DealEvaluatorAgent
// ============================================================================

export interface DealEvaluatePayload {
  dealId: string;
  scenarioId?: string;
  rationale: string;
}

export function parseDealEvaluatePayload(
  proposedPayload: Record<string, unknown> | null | undefined,
): DealEvaluatePayload | null {
  if (!proposedPayload || typeof proposedPayload !== 'object') return null;
  const dealId = proposedPayload['dealId'];
  const rationale = proposedPayload['rationale'];
  if (typeof dealId !== 'string' || typeof rationale !== 'string') {
    return null;
  }
  const out: DealEvaluatePayload = { dealId, rationale };
  if (typeof proposedPayload['scenarioId'] === 'string') {
    out.scenarioId = proposedPayload['scenarioId'] as string;
  }
  return out;
}

const dealEvaluateCostLedger = new PostgresCostLedger();

/**
 * Run DealEvaluatorAgent inline against the given deal+scenario. The
 * agent itself is deterministic (calculator + writes), so wrapping it
 * in AgentRunner mostly gives us the agent_runs row, the kill-switch
 * gate, and the ApprovalGate routing for any spawned `deal.human_review`
 * proposed action when the verdict is do_not_proceed.
 *
 * Stamping behaviour: idempotent on approval.applied_at like the other
 * deal executors. The agent run gets its own row; this approval points
 * at the dealId.
 */
export async function applyDealEvaluate(
  approvalId: string,
  payload: DealEvaluatePayload,
): Promise<ExecutorResult> {
  if (await alreadyApplied(approvalId)) return { ok: true };
  const runner = new AgentRunner({ costLedger: dealEvaluateCostLedger });
  const agent = new DealEvaluatorAgent({
    dealId: payload.dealId,
    ...(payload.scenarioId ? { scenarioId: payload.scenarioId } : {}),
  });
  const record = await runner.run(agent);
  await stampApplied(approvalId, payload.dealId, 'fuel_deal.evaluated', {
    deal_id: payload.dealId,
    scenario_id: payload.scenarioId ?? null,
    agent_run_id: record.agentRunId,
    status: record.status,
    approvals_created: record.approvalsCreated,
    cost_usd: record.costUsd,
  });
  return { ok: true, appliedObjectId: payload.dealId };
}
