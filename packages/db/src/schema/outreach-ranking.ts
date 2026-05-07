import {
  pgTable,
  uuid,
  text,
  jsonb,
  doublePrecision,
  boolean,
  timestamp,
  index,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/**
 * Per-approval feature snapshot captured AT PROPOSAL TIME, plus
 * outcome labels stamped post-approval as lifecycle events fire.
 * See migration 0089 for rationale.
 *
 * The freeform `features` JSONB is the model input; documented
 * shape lives in `packages/ai/src/outreach/features.ts`. Schema-
 * less here so new features slot in without DB migrations.
 */
export const outreachFeatureSnapshots = pgTable(
  'outreach_feature_snapshots',
  {
    /** PK + de facto FK to approvals.id (text). */
    approvalId: text('approval_id').primaryKey(),

    features: jsonb('features')
      .$type<Record<string, unknown>>()
      .notNull(),

    /** Bump when the feature vector schema changes; trained models
     *  refuse to score against an incompatible vector. */
    featureVersion: text('feature_version').notNull().default('v1'),

    repliedWithin14d: boolean('replied_within_14d'),
    meetingBooked: boolean('meeting_booked'),
    convertedToLead: boolean('converted_to_lead'),
    convertedToDeal: boolean('converted_to_deal'),
    disqualified: boolean('disqualified'),

    labelsUpdatedAt: timestamp('labels_updated_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    repliedIdx: index('outreach_feature_snapshots_replied_idx').on(
      table.repliedWithin14d,
    ),
    createdIdx: index('outreach_feature_snapshots_created_idx').on(
      table.createdAt,
    ),
  }),
);

export type OutreachFeatureSnapshot = typeof outreachFeatureSnapshots.$inferSelect;
export type NewOutreachFeatureSnapshot = typeof outreachFeatureSnapshots.$inferInsert;

/**
 * Per-(approval, model_version) prediction history. Probability of
 * replied_within_14d in [0, 1]. INTERNAL — never surface in
 * operator-facing copy.
 */
export const outreachPredictions = pgTable(
  'outreach_predictions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    approvalId: text('approval_id').notNull(),
    modelVersion: text('model_version').notNull(),
    probReply14d: doublePrecision('prob_reply_14d'),
    details: jsonb('details')
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    predictedAt: timestamp('predicted_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    approvalIdx: index('outreach_predictions_approval_idx').on(table.approvalId),
    modelIdx: index('outreach_predictions_model_idx').on(
      table.modelVersion,
      table.predictedAt,
    ),
  }),
);

export type OutreachPrediction = typeof outreachPredictions.$inferSelect;
export type NewOutreachPrediction = typeof outreachPredictions.$inferInsert;
