import {
  pgTable,
  text,
  numeric,
  jsonb,
  timestamp,
  index,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { marketProbes } from './market-probes';

/**
 * Pre-hoc hypotheses for a Market Probe (migration 0097). The
 * plan-gen agent emits 3-7 of these at probe creation time; the
 * operator edits, adds, removes. Each hypothesis is a falsifiable
 * statement with a starting confidence, a test method, and a status
 * that flips as evidence rolls in.
 *
 * Distinct from `market_probes.plan_json.hypothesis` (singular
 * free-text summary) — this table is the structured experimental
 * surface. Used by:
 *   - probe detail UI (operator-visible "what we're testing")
 *   - strategy agent (proposals must reference which hypothesis they
 *     update)
 *   - end-of-probe Learning Report (what we believed vs what changed)
 *   - playbook generation (high-confidence confirmed hypotheses
 *     graduate to playbook rules)
 */
export const marketProbeHypotheses = pgTable(
  'market_probe_hypotheses',
  {
    id: text('id').primaryKey(),
    probeId: text('probe_id')
      .notNull()
      .references(() => marketProbes.id, { onDelete: 'cascade' }),

    /** Free text — canonical kinds:
     *    target_segment | contact_title | message_angle |
     *    signal_quality | market_demand */
    hypothesisType: text('hypothesis_type').notNull(),

    /** The hypothesis as a falsifiable statement. */
    statement: text('statement').notNull(),

    /** 0-1 confidence. Start = what we believed pre-test. Current =
     *  updated as evidence rolls in. */
    confidenceStart: numeric('confidence_start').notNull().default('0.5'),
    confidenceCurrent: numeric('confidence_current').notNull().default('0.5'),

    /** Free text. How we'll know if the hypothesis holds. */
    testMethod: text('test_method'),

    /** 'active' | 'confirmed' | 'falsified' | 'unclear' | 'abandoned' */
    status: text('status').notNull().default('active'),

    /** Final call once status moves off 'active'. Feeds the Learning
     *  Report's "what changed" diff. */
    result: text('result'),

    /** Append-only evidence trail:
     *    [{ at, source: 'agent'|'operator', confidence, note,
     *       evidence: {...} }] */
    evidenceJson: jsonb('evidence_json')
      .$type<HypothesisEvidence[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),

    /** 'agent' | 'operator'. Hypotheses authored at plan-gen time
     *  default to 'agent'; operator-added entries flip to 'operator'. */
    authoredBy: text('authored_by').notNull().default('agent'),
    createdByUserId: text('created_by_user_id'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    probeIdx: index('market_probe_hypotheses_probe_idx').on(t.probeId),
    statusIdx: index('market_probe_hypotheses_status_idx').on(t.status),
  }),
);

export type MarketProbeHypothesis = typeof marketProbeHypotheses.$inferSelect;
export type NewMarketProbeHypothesis =
  typeof marketProbeHypotheses.$inferInsert;

export interface HypothesisEvidence {
  at: string;
  source: 'agent' | 'operator';
  confidence: number;
  note: string;
  evidence?: Record<string, unknown>;
}

export const HYPOTHESIS_TYPES = [
  'target_segment',
  'contact_title',
  'message_angle',
  'signal_quality',
  'market_demand',
] as const;
export type HypothesisType = (typeof HYPOTHESIS_TYPES)[number];

export const HYPOTHESIS_STATUSES = [
  'active',
  'confirmed',
  'falsified',
  'unclear',
  'abandoned',
] as const;
export type HypothesisStatus = (typeof HYPOTHESIS_STATUSES)[number];
