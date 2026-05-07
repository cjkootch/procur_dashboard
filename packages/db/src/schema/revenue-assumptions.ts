import {
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

/**
 * Revenue Assumption Map (the "Counterfactual Deal Simulator") —
 * per docs/revenue-assumption-map.md. Every fuel_deal, opportunity,
 * lead, or counterparty org gets a small decision tree of
 * assumptions that must be true for the relationship to become
 * revenue. Each assumption carries a confidence + the fastest test
 * to confirm/disprove + the action type that test maps to.
 *
 * Migration 0083. Polymorphic on (subject_type, subject_id) — v1
 * only writes for fuel_deals via the deal-room "Assumptions" tab;
 * the column shape supports opportunities / leads / orgs without
 * additional migration when those surfaces ship.
 */

export const assumptionTypeEnum = pgEnum('assumption_type', [
  /** Does the contact actually have buying/selling authority? */
  'authority',
  /** Is the product/cargo actually available at the claimed scale? */
  'availability',
  /** Is the price within market range vs benchmark / current slate? */
  'price',
  /** Is the payment route bankable (LC/SBLC/escrow capability)? */
  'payment',
  /** Is the compliance route clean (sanctions, export controls, etc.)? */
  'compliance',
  /** Is there sufficient trade-finance capacity for the cargo? */
  'bankability',
  /** Is the freight/discharge/laycan combination feasible? */
  'logistics',
  /** Does VTC have NDA + fee protection before disclosing parties? */
  'commercial_protection',
  /** Is the buyer's stated timing window realistic? */
  'timing',
  /** Do we actually have a contact path (or just a Gmail address)? */
  'relationship_access',
]);

export const assumptionStatusEnum = pgEnum('assumption_status', [
  /** Generated but no test run yet. Default for newly created rows. */
  'untested',
  /** Test in flight — outreach sent, awaiting reply / counterparty action. */
  'pending',
  /** Partial signal — some evidence gathered, decision not conclusive. */
  'partial',
  /** Confirmed — the assumption is TRUE; this dimension is no longer a risk. */
  'confirmed',
  /** Disproven — the assumption is FALSE; the deal-path is broken
   *  here. Triggers downstream: drop the lead, re-run with different
   *  counterparty, escalate to compliance review, etc. */
  'disproven',
]);

export const revenueAssumptions = pgTable(
  'revenue_assumptions',
  {
    id: text('id').primaryKey(),
    /** 'fuel_deal' | 'opportunity' | 'lead' | 'organization'. */
    subjectType: text('subject_type').notNull(),
    subjectId: text('subject_id').notNull(),
    assumptionType: assumptionTypeEnum('assumption_type').notNull(),
    assumptionText: text('assumption_text').notNull(),
    /** 0..100 — confidence the assumption is TRUE. */
    confidenceScore: integer('confidence_score').notNull().default(50),
    status: assumptionStatusEnum('status').notNull().default('untested'),
    evidenceJson: jsonb('evidence_json')
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    riskIfFalse: text('risk_if_false'),
    fastestTest: text('fastest_test'),
    /** ActionDescriptor.kind the fastest_test maps to. Optional —
     *  null when no automated action fits ("ask the buyer's bank
     *  for confirmation" doesn't have a propose_* tool). */
    recommendedActionType: text('recommended_action_type'),
    testedAt: timestamp('tested_at', { withTimezone: true }),
    result: text('result'),
    resultEvidence: jsonb('result_evidence')
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    /** Generator pipeline version — `gen-v1`, etc. Powers regression
     *  tests of the LLM generator against historical assumption sets. */
    generatorVersion: text('generator_version'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdBy: text('created_by'),
  },
  (t) => ({
    subjectIdx: index('revenue_assumptions_subject_idx').on(
      t.subjectType,
      t.subjectId,
    ),
  }),
);

export type RevenueAssumption = typeof revenueAssumptions.$inferSelect;
export type NewRevenueAssumption = typeof revenueAssumptions.$inferInsert;

/** Stable IDs for the 10 assumption types. Exposed so chat tools and
 *  the catalog generator can validate without depending on drizzle. */
export const ASSUMPTION_TYPES = [
  'authority',
  'availability',
  'price',
  'payment',
  'compliance',
  'bankability',
  'logistics',
  'commercial_protection',
  'timing',
  'relationship_access',
] as const;
export type AssumptionTypeValue = (typeof ASSUMPTION_TYPES)[number];

export const ASSUMPTION_STATUSES = [
  'untested',
  'pending',
  'partial',
  'confirmed',
  'disproven',
] as const;
export type AssumptionStatusValue = (typeof ASSUMPTION_STATUSES)[number];

export const ASSUMPTION_SUBJECT_TYPES = [
  'fuel_deal',
  'opportunity',
  'lead',
  'organization',
] as const;
export type AssumptionSubjectTypeValue = (typeof ASSUMPTION_SUBJECT_TYPES)[number];
