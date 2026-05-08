import {
  pgTable,
  text,
  integer,
  numeric,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/**
 * Market Probes (migration 0095). A probe is a bounded autonomous
 * market-prospecting experiment: pick a small low-stakes market, hand
 * the agent a scope, let it identify candidates and route low-risk
 * first-touch outreach within strict caps. Phase 1 ships the
 * foundation + Tier 0 (research-only). See SQL migration for the full
 * design rationale.
 *
 * Probes are deliberately SEPARATE from `campaigns`. A campaign is a
 * step-sequenced outbound playbook against a known target list. A
 * probe starts with a HYPOTHESIS and a market fence; the target list
 * is something the agent BUILDS as part of running the probe.
 */
export const marketProbes = pgTable(
  'market_probes',
  {
    id: text('id').primaryKey(),

    marketName: text('market_name').notNull(),
    /** ISO-2; null for cross-border probes. */
    country: text('country'),
    productThesis: text('product_thesis').notNull(),
    /** 'low' | 'medium' | 'high'. */
    riskLevel: text('risk_level').notNull().default('low'),
    /** 'planning' | 'active' | 'paused' | 'completed' | 'abandoned'. */
    status: text('status').notNull().default('planning'),
    /** 0 research-only (default) | 1 first-touch autopilot
     *  | 2 follow-up autopilot | 3 human-gated commercial drafting. */
    tier: integer('tier').notNull().default(0),

    objective: text('objective'),
    successCriteriaJson: jsonb('success_criteria_json')
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),

    allowedChannels: text('allowed_channels')
      .array()
      .notNull()
      .default(sql`ARRAY['email']::text[]`),
    allowedSegments: text('allowed_segments')
      .array()
      .notNull()
      .default(sql`ARRAY[]::text[]`),

    blockedTerms: text('blocked_terms')
      .array()
      .notNull()
      .default(sql`ARRAY[]::text[]`),
    blockedEntitySlugs: text('blocked_entity_slugs')
      .array()
      .notNull()
      .default(sql`ARRAY[]::text[]`),

    dailySendLimit: integer('daily_send_limit').notNull().default(10),
    totalSendLimit: integer('total_send_limit').notNull().default(50),
    maxFollowupsPerContact: integer('max_followups_per_contact')
      .notNull()
      .default(1),

    /** Plan shape:
     *    { hypothesis, segments[], outreachAngle, successCriteria[],
     *      tasks: [{ id, label, status, completedAt?, result? }] }
     *  Tasks are operator-visible — the dashboard renders them as a
     *  crossing-off checklist as the agent advances. */
    planJson: jsonb('plan_json')
      .$type<ProbePlan>()
      .notNull()
      .default(sql`'{}'::jsonb`),

    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    statusIdx: index('market_probes_status_idx').on(t.status),
    countryIdx: index('market_probes_country_idx').on(t.country),
    createdAtIdx: index('market_probes_created_at_idx').on(t.createdAt),
  }),
);

export const marketProbeTargets = pgTable(
  'market_probe_targets',
  {
    id: text('id').primaryKey(),
    probeId: text('probe_id')
      .notNull()
      .references(() => marketProbes.id, { onDelete: 'cascade' }),

    entitySlug: text('entity_slug').notNull(),
    contactId: text('contact_id'),
    segment: text('segment'),

    /** 'A' | 'B' | 'C' | 'D'. Phase 2 autopilot only sends to A/B. */
    fitTier: text('fit_tier').notNull().default('C'),
    confidence: numeric('confidence').notNull().default('0'),
    evidenceJson: jsonb('evidence_json')
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),

    /** 'pending' | 'drafted' | 'queued' | 'sent' | 'bounced' | 'skipped'. */
    sendStatus: text('send_status').notNull().default('pending'),
    lastTouchAt: timestamp('last_touch_at', { withTimezone: true }),

    /** 'positive' | 'routing' | 'objection' | 'unsubscribe' | 'none'. */
    replyStatus: text('reply_status'),
    /** 'qualified' | 'disqualified' | 'parked' | 'none'. */
    disposition: text('disposition'),
    humanFeedback: text('human_feedback'),

    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    probeIdx: index('market_probe_targets_probe_idx').on(t.probeId),
    entityIdx: index('market_probe_targets_entity_idx').on(t.entitySlug),
    probeEntityUniq: uniqueIndex('market_probe_targets_probe_entity_uniq').on(
      t.probeId,
      t.entitySlug,
    ),
  }),
);

export type MarketProbe = typeof marketProbes.$inferSelect;
export type NewMarketProbe = typeof marketProbes.$inferInsert;
export type MarketProbeTarget = typeof marketProbeTargets.$inferSelect;
export type NewMarketProbeTarget = typeof marketProbeTargets.$inferInsert;

/**
 * The agent-produced plan rendered as a checklist on the probe
 * dashboard. Each task crosses off as the agent advances; tasks can
 * also be marked skipped when the operator overrides ("no need to
 * find named contacts — generic info@ addresses are fine").
 */
export interface ProbePlan {
  hypothesis?: string;
  segments?: string[];
  outreachAngle?: string;
  successCriteria?: string[];
  tasks?: ProbeTask[];
}

export interface ProbeTask {
  id: string;
  label: string;
  status: 'pending' | 'in_progress' | 'done' | 'skipped';
  completedAt?: string;
  result?: string;
}
