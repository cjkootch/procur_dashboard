import 'server-only';
import { and, desc, eq } from 'drizzle-orm';
import {
  db,
  marketProbeStrategyProposals,
  type MarketProbe,
  type MarketProbeStrategyProposal,
  type NewMarketProbeStrategyProposal,
  type ProbePlan,
  type StrategyProposalPayload,
} from '@procur/db';
import { createId } from '@procur/ai';
import {
  getProbe,
  setProbePlan,
  setProbeStatus,
} from './market-probes';

/**
 * Strategy proposal lifecycle for Market Probes. The agent observes a
 * probe's metrics + atlas + recent activity and proposes plan changes
 * via `insertStrategyProposal`. Operator reviews + approves/rejects.
 *
 * Approve → proposal applied to probe.plan_json (or status flip for
 * pause/complete proposals).
 * Reject → reviewer_feedback rides into the next plan-generation pass
 * as a constraint, so the agent learns from the rejection.
 *
 * Discipline: the agent NEVER mutates probe.plan_json directly. This
 * module is the only path that writes plan changes — and only through
 * the operator-approval gate.
 */

export const STRATEGY_PROPOSAL_TYPES = [
  'shift_segment',
  'add_segment',
  'pause_segment',
  'change_template',
  'tighten_targeting',
  'loosen_targeting',
  'shift_titles',
  'pause_probe',
  'complete_probe',
] as const;
export type StrategyProposalType = (typeof STRATEGY_PROPOSAL_TYPES)[number];

export interface InsertStrategyProposalInput {
  probeId: string;
  proposalType: StrategyProposalType | string;
  rationale: string;
  payload: StrategyProposalPayload;
  evidence: Record<string, unknown>;
}

export async function insertStrategyProposal(
  input: InsertStrategyProposalInput,
): Promise<MarketProbeStrategyProposal> {
  const row: NewMarketProbeStrategyProposal = {
    id: createId(),
    probeId: input.probeId,
    proposalType: input.proposalType,
    rationale: input.rationale,
    payloadJson: input.payload,
    evidenceJson: input.evidence,
    status: 'proposed',
  };
  const [created] = await db
    .insert(marketProbeStrategyProposals)
    .values(row)
    .returning();
  if (!created) throw new Error('insertStrategyProposal: no row returned');
  return created;
}

export async function listStrategyProposals(
  probeId: string,
  options: { status?: string } = {},
): Promise<MarketProbeStrategyProposal[]> {
  const conditions = [eq(marketProbeStrategyProposals.probeId, probeId)];
  if (options.status) {
    conditions.push(eq(marketProbeStrategyProposals.status, options.status));
  }
  return await db
    .select()
    .from(marketProbeStrategyProposals)
    .where(and(...conditions))
    .orderBy(desc(marketProbeStrategyProposals.createdAt));
}

/**
 * Apply an approved proposal to the probe. Mutates `probe.plan_json`
 * for plan-shape changes (shift_segment, change_template, etc.) or
 * flips probe.status for lifecycle proposals (pause_probe,
 * complete_probe). Idempotent — already-approved proposals short-
 * circuit.
 *
 * Returns the updated probe so the caller can revalidate.
 */
export async function approveStrategyProposal(input: {
  proposalId: string;
  reviewedByUserId: string;
}): Promise<MarketProbe | null> {
  const [proposal] = await db
    .select()
    .from(marketProbeStrategyProposals)
    .where(eq(marketProbeStrategyProposals.id, input.proposalId))
    .limit(1);
  if (!proposal) return null;
  if (proposal.status === 'approved' && proposal.appliedAt) {
    // Idempotent re-approval — return current probe state.
    return getProbe(proposal.probeId);
  }
  if (proposal.status === 'rejected' || proposal.status === 'superseded') {
    throw new Error(
      `proposal ${proposal.id} cannot be approved (status: ${proposal.status})`,
    );
  }

  const probe = await getProbe(proposal.probeId);
  if (!probe) return null;

  const plan = probe.planJson ?? {};
  const after = (proposal.payloadJson?.after ?? {}) as Record<string, unknown>;

  let updatedProbe: MarketProbe | null = null;

  switch (proposal.proposalType) {
    case 'shift_segment':
    case 'add_segment':
    case 'pause_segment':
    case 'shift_titles': {
      // Segment / title proposals modify plan.segments. The agent
      // emits the full new segments[] in payload.after.segments.
      const nextSegments = Array.isArray(after['segments'])
        ? (after['segments'] as string[])
        : plan.segments ?? [];
      const newPlan: ProbePlan = { ...plan, segments: nextSegments };
      updatedProbe = await setProbePlan(proposal.probeId, newPlan);
      break;
    }
    case 'change_template': {
      // Outreach-angle / first-touch template change. Stored as
      // plan.outreachAngle. The agent emits the new copy in
      // payload.after.outreachAngle.
      const nextAngle =
        typeof after['outreachAngle'] === 'string'
          ? (after['outreachAngle'] as string)
          : plan.outreachAngle;
      const newPlan: ProbePlan = { ...plan, outreachAngle: nextAngle };
      updatedProbe = await setProbePlan(proposal.probeId, newPlan);
      break;
    }
    case 'tighten_targeting':
    case 'loosen_targeting': {
      // Targeting threshold lives in plan.successCriteria for now —
      // Phase 2F will move it to a structured field. Today we just
      // record the change in successCriteria as an annotation.
      const next = Array.isArray(after['successCriteria'])
        ? (after['successCriteria'] as string[])
        : plan.successCriteria ?? [];
      const newPlan: ProbePlan = { ...plan, successCriteria: next };
      updatedProbe = await setProbePlan(proposal.probeId, newPlan);
      break;
    }
    case 'pause_probe': {
      await setProbeStatus(proposal.probeId, 'paused');
      updatedProbe = await getProbe(proposal.probeId);
      break;
    }
    case 'complete_probe': {
      await setProbeStatus(proposal.probeId, 'completed');
      updatedProbe = await getProbe(proposal.probeId);
      break;
    }
    default:
      throw new Error(
        `unknown proposal_type: ${proposal.proposalType}`,
      );
  }

  await db
    .update(marketProbeStrategyProposals)
    .set({
      status: 'approved',
      reviewedAt: new Date(),
      reviewedByUserId: input.reviewedByUserId,
      appliedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(marketProbeStrategyProposals.id, proposal.id));

  return updatedProbe;
}

/**
 * Reject a proposal with operator feedback. The feedback rides into
 * the NEXT plan-generation pass — when the agent proposes its next
 * round of changes, it sees the rejection history and the rationale,
 * so it doesn't re-propose a rejected pivot or it adapts the proposal
 * to address the operator's concern. This is the learning loop.
 */
export async function rejectStrategyProposal(input: {
  proposalId: string;
  reviewedByUserId: string;
  feedback: string;
}): Promise<void> {
  await db
    .update(marketProbeStrategyProposals)
    .set({
      status: 'rejected',
      reviewerFeedback: input.feedback,
      reviewedAt: new Date(),
      reviewedByUserId: input.reviewedByUserId,
      updatedAt: new Date(),
    })
    .where(eq(marketProbeStrategyProposals.id, input.proposalId));
}

/**
 * Pull rejected proposals + their feedback for a probe, oldest first.
 * Fed into the agent's next plan-generation prompt as rejection
 * context — "operator rejected pivoting to marine ops because they
 * have no marine relationships yet; don't re-propose."
 */
export async function listRejectionHistory(
  probeId: string,
  limit = 20,
): Promise<
  Array<{
    proposalType: string;
    rationale: string;
    feedback: string | null;
    rejectedAt: Date;
  }>
> {
  const rows = await db
    .select({
      proposalType: marketProbeStrategyProposals.proposalType,
      rationale: marketProbeStrategyProposals.rationale,
      feedback: marketProbeStrategyProposals.reviewerFeedback,
      rejectedAt: marketProbeStrategyProposals.reviewedAt,
    })
    .from(marketProbeStrategyProposals)
    .where(
      and(
        eq(marketProbeStrategyProposals.probeId, probeId),
        eq(marketProbeStrategyProposals.status, 'rejected'),
      ),
    )
    .orderBy(desc(marketProbeStrategyProposals.reviewedAt))
    .limit(limit);
  return rows.map((r) => ({
    proposalType: r.proposalType,
    rationale: r.rationale,
    feedback: r.feedback,
    rejectedAt: r.rejectedAt ?? new Date(0),
  }));
}
