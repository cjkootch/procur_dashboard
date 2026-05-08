import {
  pgTable,
  text,
  integer,
  timestamp,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { marketProbes } from './market-probes';

/**
 * Per-(probe, segment) coverage tracking (migration 0098). Lets the
 * operator see when a segment is well-covered vs. when there's still
 * surface area. estimatedTotal is operator-set (or agent-suggested);
 * the count fields auto-aggregate from market_probe_targets via the
 * refreshSegmentCounts catalog helper.
 *
 * Distinct from probe.plan_json.segments — that's the LIST of
 * segments the probe is targeting; THIS is the per-segment progress
 * map.
 */
export const marketMapSegments = pgTable(
  'market_map_segments',
  {
    id: text('id').primaryKey(),
    probeId: text('probe_id')
      .notNull()
      .references(() => marketProbes.id, { onDelete: 'cascade' }),

    segmentName: text('segment_name').notNull(),
    /** Operator/agent estimate of total real companies fitting this
     *  segment in the probe's market. Drives the % coverage metric.
     *  Null = "we don't know yet"; coverage shown as absolute counts. */
    estimatedTotal: integer('estimated_total'),

    /** Auto-aggregated counts from market_probe_targets. */
    identifiedCount: integer('identified_count').notNull().default(0),
    contactedCount: integer('contacted_count').notNull().default(0),
    repliedCount: integer('replied_count').notNull().default(0),

    notes: text('notes'),

    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    probeIdx: index('market_map_segments_probe_idx').on(t.probeId),
    probeSegmentUniq: uniqueIndex('market_map_segments_probe_segment_uniq').on(
      t.probeId,
      t.segmentName,
    ),
  }),
);

export type MarketMapSegment = typeof marketMapSegments.$inferSelect;
export type NewMarketMapSegment = typeof marketMapSegments.$inferInsert;
