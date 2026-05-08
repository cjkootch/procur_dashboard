import {
  pgTable,
  text,
  jsonb,
  timestamp,
  index,
} from 'drizzle-orm/pg-core';
import { marketProbes } from './market-probes';

/**
 * End-of-probe learning reports (migration 0099). Sonnet pass over
 * scorecard + atlas + hypotheses + feedback emits a structured
 * synthesis the operator + future probes both consume.
 *
 * Stored (not just generated transiently) so:
 *   - operator can re-read past reports
 *   - the playbook generator can read the report's
 *     bestSegment/bestContactTitle/strongestSignal nominations
 *   - cross-probe analysis ("what did we learn across all 5
 *     Caribbean food probes?") joins reports
 */
export const marketProbeLearningReports = pgTable(
  'market_probe_learning_reports',
  {
    id: text('id').primaryKey(),
    probeId: text('probe_id')
      .notNull()
      .references(() => marketProbes.id, { onDelete: 'cascade' }),

    /** TL;DR — one sentence shown on probe detail + dashboard cards. */
    summary: text('summary').notNull(),

    /** Full structured report. See learning-report-agent.ts for the
     *  output schema. */
    payloadJson: jsonb('payload_json')
      .$type<LearningReportPayload>()
      .notNull()
      .default({} as LearningReportPayload),

    /** Snapshot of the scorecard at report time — reproducibility. */
    scorecardSnapshotJson: jsonb('scorecard_snapshot_json')
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),

    generatedByModel: text('generated_by_model'),
    generatedAt: timestamp('generated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    probeIdx: index('market_probe_learning_reports_probe_idx').on(t.probeId),
    generatedAtIdx: index(
      'market_probe_learning_reports_generated_at_idx',
    ).on(t.generatedAt),
  }),
);

export type MarketProbeLearningReport =
  typeof marketProbeLearningReports.$inferSelect;
export type NewMarketProbeLearningReport =
  typeof marketProbeLearningReports.$inferInsert;

/**
 * Structured shape of the agent's learning report. Matches the
 * Sonnet system prompt's expected output.
 */
export interface LearningReportPayload {
  whatWeBelievedAtStart?: string;
  whatChanged?: string;
  whatWorked?: string[];
  whatFailed?: string[];
  bestSegment?: { name: string; evidence: string };
  worstSegment?: { name: string; evidence: string };
  bestContactTitle?: { title: string; evidence: string };
  bestMessageVariant?: { variantName: string; evidence: string };
  strongestSignal?: {
    signal: string;
    replyDelta: number;
    evidence: string;
  };
  noisySignals?: string[];
  /** Proposed atlas negative_rule entries — operator approves to
   *  promote into atlas as cross-probe behavioral constraints. */
  badTargetRules?: Array<{ rule: string; rationale: string }>;
  recommendedNextProbe?: {
    country?: string;
    segments?: string[];
    hypothesesSeed?: Array<{ hypothesisType: string; statement: string }>;
    rationale?: string;
  };
  playbookUpdates?: {
    name?: string;
    applicableCountries?: string[];
    recommendedSegments?: string[];
    avoidedSegments?: string[];
    bestContactTitles?: string[];
    avoidedContactTitles?: string[];
    bestFirstTouchAngle?: string;
    rationale?: string;
  };
}
