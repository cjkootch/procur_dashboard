import 'server-only';
import { and, eq, desc } from 'drizzle-orm';
import {
  db,
  pursuitGateReviews,
  pursuits,
  users,
  type GateReviewCriterion,
  type PursuitGateReview,
} from '@procur/db';

/**
 * Canonical gate keys. Matches our pursuit stages loosely:
 *   - qualification      before moving into capture planning
 *   - capture_planning   before moving into proposal development
 *   - proposal_development   mid-draft gate
 *   - final              pre-submission sign-off
 *
 * Stored as text in the DB so teams can add custom gates without a
 * migration. When rendering unknown gates, the UI falls back to the
 * raw string.
 */
export const GATE_STAGES = [
  'qualification',
  'capture_planning',
  'proposal_development',
  'final',
] as const;
export type GateStage = (typeof GATE_STAGES)[number];

export const GATE_STAGE_LABEL: Record<GateStage, string> = {
  qualification: 'Qualification',
  capture_planning: 'Capture planning',
  proposal_development: 'Proposal development',
  final: 'Final submission',
};

/**
 * Default criteria per gate. Seeded into new reviews on creation; teams
 * can edit / remove / add rows from the UI. Criteria ids are stable
 * within a gate so repeated reviews against the same gate carry consistent
 * analytics keys if we ever denormalize.
 */
export const DEFAULT_GATE_CRITERIA: Record<GateStage, Omit<GateReviewCriterion, 'status'>[]> = {
  qualification: [
    { id: 'qual-budget', label: 'Customer budget confirmed or indicative', sortOrder: 0 },
    { id: 'qual-incumbent', label: 'Incumbent identified + relationship assessed', sortOrder: 1 },
    { id: 'qual-fit', label: 'Requirements align with our capabilities', sortOrder: 2 },
    { id: 'qual-timeline', label: 'Submission window is realistic for our team', sortOrder: 3 },
    { id: 'qual-win-theme', label: 'Initial win theme articulated', sortOrder: 4 },
  ],
  capture_planning: [
    { id: 'cap-themes', label: 'Win themes drafted', sortOrder: 0 },
    { id: 'cap-competitors', label: 'Competitors mapped with strengths/weaknesses', sortOrder: 1 },
    { id: 'cap-diffs', label: 'Differentiators identified', sortOrder: 2 },
    { id: 'cap-teaming', label: 'Teaming partners confirmed or ruled out', sortOrder: 3 },
    { id: 'cap-risks', label: 'Top risks identified with mitigations', sortOrder: 4 },
    { id: 'cap-pwin', label: 'P(Win) scored with reasoning', sortOrder: 5 },
  ],
  proposal_development: [
    { id: 'prop-tender', label: 'Tender documents ingested', sortOrder: 0 },
    { id: 'prop-compliance', label: 'Compliance matrix built', sortOrder: 1 },
    { id: 'prop-outline', label: 'Outline reviewed and approved', sortOrder: 2 },
    { id: 'prop-sections', label: 'Section owners assigned', sortOrder: 3 },
    { id: 'prop-pricing', label: 'Pricing strategy set and approved', sortOrder: 4 },
    { id: 'prop-past-perf', label: 'Relevant past performance identified', sortOrder: 5 },
  ],
  final: [
    { id: 'fin-sections', label: 'All sections drafted and reviewed', sortOrder: 0 },
    { id: 'fin-compliance', label: 'All compliance items addressed', sortOrder: 1 },
    { id: 'fin-ai-review', label: 'AI review run, critical issues addressed', sortOrder: 2 },
    { id: 'fin-pricing', label: 'Pricing signed off', sortOrder: 3 },
    { id: 'fin-docs', label: 'Mandatory documents complete and attached', sortOrder: 4 },
    { id: 'fin-checklist', label: 'Submission checklist reviewed end-to-end', sortOrder: 5 },
  ],
};

export function seedCriteria(stage: string): GateReviewCriterion[] {
  const base = DEFAULT_GATE_CRITERIA[stage as GateStage] ?? [];
  return base.map((c) => ({ ...c, status: 'not_assessed' }));
}

export type GateReviewRow = PursuitGateReview & {
  reviewerName: string | null;
};

export async function listGateReviewsForPursuit(pursuitId: string): Promise<GateReviewRow[]> {
  const rows = await db
    .select({
      id: pursuitGateReviews.id,
      pursuitId: pursuitGateReviews.pursuitId,
      stage: pursuitGateReviews.stage,
      decision: pursuitGateReviews.decision,
      reviewerUserId: pursuitGateReviews.reviewerUserId,
      summary: pursuitGateReviews.summary,
      criteria: pursuitGateReviews.criteria,
      createdAt: pursuitGateReviews.createdAt,
      updatedAt: pursuitGateReviews.updatedAt,
      completedAt: pursuitGateReviews.completedAt,
      reviewerFirstName: users.firstName,
      reviewerLastName: users.lastName,
    })
    .from(pursuitGateReviews)
    .leftJoin(users, eq(users.id, pursuitGateReviews.reviewerUserId))
    .where(eq(pursuitGateReviews.pursuitId, pursuitId))
    .orderBy(desc(pursuitGateReviews.createdAt));

  return rows.map((r) => ({
    id: r.id,
    pursuitId: r.pursuitId,
    stage: r.stage,
    decision: r.decision,
    reviewerUserId: r.reviewerUserId,
    summary: r.summary,
    criteria: r.criteria,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    completedAt: r.completedAt,
    reviewerName:
      [r.reviewerFirstName, r.reviewerLastName].filter(Boolean).join(' ') || null,
  }));
}

/**
 * Ownership-checked fetch. Returns null if the gate review doesn't exist
 * OR if it belongs to a pursuit the given company doesn't own — so
 * callers can return 404 for either case without leaking existence.
 */
export async function getGateReviewForCompany(
  companyId: string,
  gateReviewId: string,
): Promise<PursuitGateReview | null> {
  const [row] = await db
    .select({
      review: pursuitGateReviews,
    })
    .from(pursuitGateReviews)
    .innerJoin(pursuits, eq(pursuits.id, pursuitGateReviews.pursuitId))
    .where(
      and(eq(pursuitGateReviews.id, gateReviewId), eq(pursuits.companyId, companyId)),
    )
    .limit(1);
  return row?.review ?? null;
}
