import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { campaigns } from './campaigns';

/**
 * Per docs/vex-into-procur-merge-brief.md Phase 4. Ordered step
 * sequence for a campaign plan. The enrollment workflow advances
 * recipients through steps by `position`. `gate_condition_json` is a
 * narrow JSON DSL evaluated before dispatch (`{}` = always true).
 * `auto_approve = true` shortcuts the ApprovalGate for trusted
 * sequences; default false enforces "decide → ask → execute".
 */
export const campaignSteps = pgTable(
  'campaign_steps',
  {
    id: text('id').primaryKey(),
    campaignId: text('campaign_id')
      .notNull()
      .references(() => campaigns.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    channel: text('channel').notNull(),
    delayAfterPriorMs: integer('delay_after_prior_ms').notNull().default(0),
    /** Template registry name resolved at dispatch. Null when the step
     *  ships inline content via subjectOverride / bodyOverride, or for
     *  manual steps. */
    templateRef: text('template_ref'),
    subjectOverride: text('subject_override'),
    bodyOverride: text('body_override'),
    gateConditionJson: jsonb('gate_condition_json')
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    /** ApprovalTier: T0 / T1 / T2 / T3. */
    tier: text('tier').notNull().default('T2'),
    autoApprove: boolean('auto_approve').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    campaignIdx: index('campaign_steps_campaign_idx').on(t.campaignId),
    uniqPosition: uniqueIndex('campaign_steps_position_uniq').on(
      t.campaignId,
      t.position,
    ),
  }),
);

export type CampaignStep = typeof campaignSteps.$inferSelect;
export type NewCampaignStep = typeof campaignSteps.$inferInsert;
