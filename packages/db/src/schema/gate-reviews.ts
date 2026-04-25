import { pgTable, uuid, text, timestamp, jsonb, index } from 'drizzle-orm/pg-core';
import { pursuits } from './pursuits';
import { users } from './users';

/**
 * Structured stage-gate review for a pursuit. Records a point-in-time
 * assessment against a checklist of criteria (stored as JSONB) plus an
 * overall decision + reviewer + summary.
 *
 * JSONB for criteria keeps the v1 schema tight — no join table, no
 * per-criterion row churn when reviewers toggle statuses. Cross-pursuit
 * criteria analytics (e.g. "which criteria fail most often") will need
 * either an expand-on-write trigger or a denormalized criteria table
 * later; not worth the complexity yet.
 *
 * Gates we model (v1):
 *   qualification          between identification and qualification
 *   capture_planning       before moving into proposal development
 *   proposal_development   mid-draft check
 *   final                  pre-submission sign-off
 *
 * Stored as free text so teams can add their own gates without a
 * schema migration. Default criteria per gate live in
 * apps/app/lib/gate-review-queries.ts.
 */

export type GateReviewDecision = 'pending' | 'pass' | 'conditional' | 'fail';
export type GateReviewCriterionStatus =
  | 'not_assessed'
  | 'met'
  | 'partially_met'
  | 'not_met'
  | 'na';

export type GateReviewCriterion = {
  id: string;
  label: string;
  status: GateReviewCriterionStatus;
  comment?: string;
  sortOrder: number;
};

export const pursuitGateReviews = pgTable(
  'pursuit_gate_reviews',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    pursuitId: uuid('pursuit_id')
      .references(() => pursuits.id, { onDelete: 'cascade' })
      .notNull(),

    /** Gate key — 'qualification' | 'capture_planning' | 'proposal_development' | 'final' (or custom). */
    stage: text('stage').notNull(),
    decision: text('decision').$type<GateReviewDecision>().notNull().default('pending'),

    reviewerUserId: uuid('reviewer_user_id').references(() => users.id, { onDelete: 'set null' }),
    summary: text('summary'),
    criteria: jsonb('criteria').$type<GateReviewCriterion[]>().notNull().default([]),

    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
    completedAt: timestamp('completed_at'),
  },
  (table) => ({
    pursuitIdx: index('pursuit_gate_reviews_pursuit_idx').on(table.pursuitId),
    pursuitStageIdx: index('pursuit_gate_reviews_pursuit_stage_idx').on(
      table.pursuitId,
      table.stage,
    ),
  }),
);

export type PursuitGateReview = typeof pursuitGateReviews.$inferSelect;
export type NewPursuitGateReview = typeof pursuitGateReviews.$inferInsert;
