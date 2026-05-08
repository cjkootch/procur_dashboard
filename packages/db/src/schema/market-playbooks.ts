import {
  pgTable,
  text,
  integer,
  jsonb,
  timestamp,
  index,
} from 'drizzle-orm/pg-core';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/**
 * Market playbooks (migration 0099). Versioned, reusable templates
 * for new probes. A confirmed Caribbean-food probe can save itself as
 * a playbook; the next probe in Bahamas / Jamaica / Cayman starts
 * pre-filled with segments + hypotheses + outreach angle + contact
 * titles + compliance notes.
 *
 * Versioning: each refine bumps `version` and sets
 * `parentPlaybookId` to the previous version. Fork chains traceable
 * back to root.
 */
export const marketPlaybooks = pgTable(
  'market_playbooks',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    description: text('description'),

    /** ISO-2 country codes the playbook applies to. Empty = market-
     *  agnostic. Fork-from-playbook UI filters by intersection. */
    applicableCountries: text('applicable_countries')
      .array()
      .notNull()
      .default(sql`ARRAY[]::text[]`),

    recommendedSegments: text('recommended_segments')
      .array()
      .notNull()
      .default(sql`ARRAY[]::text[]`),
    avoidedSegments: text('avoided_segments')
      .array()
      .notNull()
      .default(sql`ARRAY[]::text[]`),

    bestContactTitles: text('best_contact_titles')
      .array()
      .notNull()
      .default(sql`ARRAY[]::text[]`),
    avoidedContactTitles: text('avoided_contact_titles')
      .array()
      .notNull()
      .default(sql`ARRAY[]::text[]`),

    /** Pre-seed hypotheses for forked probes. Shape:
     *    [{ hypothesisType, statement, confidenceStart, testMethod }] */
    baseHypothesesJson: jsonb('base_hypotheses_json')
      .$type<
        Array<{
          hypothesisType: string;
          statement: string;
          confidenceStart: number;
          testMethod?: string;
        }>
      >()
      .notNull()
      .default([]),

    bestFirstTouchAngle: text('best_first_touch_angle'),

    commonObjectionsJson: jsonb('common_objections_json')
      .$type<Array<{ objection: string; response: string }>>()
      .notNull()
      .default([]),

    usefulDataSources: text('useful_data_sources')
      .array()
      .notNull()
      .default(sql`ARRAY[]::text[]`),

    complianceNotes: text('compliance_notes'),

    followUpCadenceJson: jsonb('follow_up_cadence_json')
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),

    /** Conversion benchmarks measured from the source probe(s).
     *  { replyRate, routingRate, qualifiedInterestRate, bounceRate } */
    conversionBenchmarksJson: jsonb('conversion_benchmarks_json')
      .$type<Record<string, number>>()
      .notNull()
      .default({}),

    sourceProbeIds: text('source_probe_ids')
      .array()
      .notNull()
      .default(sql`ARRAY[]::text[]`),

    version: integer('version').notNull().default(1),
    parentPlaybookId: text('parent_playbook_id').references(
      (): AnyPgColumn => marketPlaybooks.id,
      { onDelete: 'set null' },
    ),

    /** 'draft' | 'active' | 'deprecated'. */
    status: text('status').notNull().default('draft'),

    createdByUserId: text('created_by_user_id'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    statusIdx: index('market_playbooks_status_idx').on(t.status),
    parentIdx: index('market_playbooks_parent_idx').on(t.parentPlaybookId),
  }),
);

export type MarketPlaybook = typeof marketPlaybooks.$inferSelect;
export type NewMarketPlaybook = typeof marketPlaybooks.$inferInsert;
