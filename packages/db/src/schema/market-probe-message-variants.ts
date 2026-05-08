import {
  pgTable,
  text,
  numeric,
  timestamp,
  index,
} from 'drizzle-orm/pg-core';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { marketProbes } from './market-probes';

/**
 * Message variant testing for Market Probes (migration 0102).
 *
 * Operator authors 2-3 variants per probe (different subject lines,
 * outreach angles, tones). Autopilot picks one per target via
 * weighted sampling among 'active' variants and stamps
 * market_probe_targets.variant_id at draft time. Per-variant outcomes
 * (sent / replied / positive / bounced) aggregate via GROUP BY at
 * scorecard read time — no denormalization to risk drifting.
 *
 * Status flow:
 *   active   — eligible for autopilot selection
 *   paused   — operator temporarily disabled (no new sends)
 *   winner   — operator promoted; autopilot uses ONLY this variant.
 *              Demotes other 'active' variants to 'archived' implicitly.
 *   archived — kept for history; never picked again
 */
export const marketProbeMessageVariants = pgTable(
  'market_probe_message_variants',
  {
    id: text('id').primaryKey(),
    probeId: text('probe_id')
      .notNull()
      .references(() => marketProbes.id, { onDelete: 'cascade' }),

    variantName: text('variant_name').notNull(),
    /** 'active' | 'paused' | 'winner' | 'archived' */
    status: text('status').notNull().default('active'),

    subjectTemplate: text('subject_template'),
    bodyTemplate: text('body_template'),
    angle: text('angle'),

    /** Sampling weight when autopilot picks among active variants.
     *  Default 1 = uniform. Operator bumps a winning variant to
     *  push more traffic without yet promoting to 'winner'. */
    weight: numeric('weight').notNull().default('1'),

    notes: text('notes'),

    /** Self-FK so v2 of a variant points at v1 in a fork chain. */
    parentVariantId: text('parent_variant_id').references(
      (): AnyPgColumn => marketProbeMessageVariants.id,
      { onDelete: 'set null' },
    ),

    createdByUserId: text('created_by_user_id'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    probeIdx: index('market_probe_message_variants_probe_idx').on(t.probeId),
    statusIdx: index('market_probe_message_variants_status_idx').on(
      t.probeId,
      t.status,
    ),
  }),
);

export type MarketProbeMessageVariant =
  typeof marketProbeMessageVariants.$inferSelect;
export type NewMarketProbeMessageVariant =
  typeof marketProbeMessageVariants.$inferInsert;

export const VARIANT_STATUSES = [
  'active',
  'paused',
  'winner',
  'archived',
] as const;
export type VariantStatus = (typeof VARIANT_STATUSES)[number];
