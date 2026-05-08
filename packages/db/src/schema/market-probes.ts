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

    /** Probe ladder stage (migration 0097). Sequential 5-stage path:
     *    market_structure → routing → pain_discovery →
     *    commercial_qualification → deal_room_conversion
     *  Hard discipline rule: agent cannot skip ahead — strategy
     *  proposals to advance the stage are gated on evidence from
     *  earlier stages. New probes start at market_structure. */
    ladderStage: text('ladder_stage')
      .notNull()
      .default('market_structure'),

    /** Phase 2G safety net: probe operating mode.
     *    'experiment'    — bounded learning probe. Tier 1 autopilot
     *                      eligible.
     *    'relationship'  — strategic-account probe. Higher discipline;
     *                      Tier 1 autopilot disabled regardless of
     *                      probe.tier value. */
    mode: text('mode').notNull().default('experiment'),

    /** Auto-pause thresholds (migration 0100). Phase 2H autopilot
     *  reads these before every send batch and pauses the probe
     *  when any threshold is exceeded. Operator can edit per probe. */
    maxBounceRatePct: numeric('max_bounce_rate_pct').notNull().default('8'),
    maxComplaintRatePct: numeric('max_complaint_rate_pct')
      .notNull()
      .default('1'),
    maxNoReplyBeforeSegmentPause: integer('max_no_reply_before_segment_pause')
      .notNull()
      .default(12),
    maxTotalNoSignalBeforeProbePause: integer(
      'max_total_no_signal_before_probe_pause',
    )
      .notNull()
      .default(30),

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

    /** Per-probe outreach identity. When set, autopilot dispatch
     *  (and the chat-tool path when called with this probe's id)
     *  override the company-level email sender display name +
     *  signatures with these. The underlying From address stays
     *  the company-default Resend address (avoids per-probe DNS /
     *  identity verification); only the display name + signature
     *  shift. NULL falls back to companies.email_sender_display_name
     *  + email_signature_text/html (existing behavior). For
     *  lead_form, alias also fills the form's name_field, replacing
     *  the LEAD_FORM_SENDER_NAME env default. */
    alias: text('alias'),
    emailSignatureText: text('email_signature_text'),
    emailSignatureHtml: text('email_signature_html'),

    /** Free-text domain tag for the probe — operator-defined slug
     *  identifying the kind of bet this probe is testing. Examples:
     *  'fuel_supply' (default for fuel-procurement probes),
     *  'ma_matchmaking' (cross-border M&A), 'pe_buyers',
     *  'succession_targets', 'food_distribution'. Used by
     *  cross-probe memory (listRecentLearningReportsByCountry) to
     *  filter prior reports — without this filter, a Japan fuel
     *  probe's lessons would feed into a Japan M&A probe's
     *  strategy-agent prompt. NULL means "no domain set"; the
     *  cross-probe memory filter falls back to country-only join
     *  (existing behavior — preserves zero impact on probes that
     *  don't set this). */
    domain: text('domain'),

    /** Per-probe formality level passed into the drafter prompt.
     *  The base prompt is "professional, single ask" — that fits
     *  most US/EU procurement contexts. For first-contact M&A
     *  outreach to a 65-year-old Japanese factory owner, deference
     *  + indirection matter. For warm-market follow-ups, a casual
     *  tone reads better. The drafter respects this level when
     *  set; null falls back to "professional" (existing behavior).
     *
     *  Levels:
     *    'high'         — formal register; honorifics where the
     *                     target language has them (e.g. 敬語 for
     *                     Japanese, vous for French, Sie for
     *                     German); indirect ask; "would you be
     *                     open to..." not "let's get on a call"
     *    'professional' — default. Direct but courteous; first-
     *                     name basis where culturally appropriate
     *    'casual'       — warm-market tone; first-name only;
     *                     short; conversational
     */
    formalityLevel: text('formality_level'),

    /** Free-text guidance the drafter receives in addition to the
     *  intent. Captures the operator's domain-specific framing the
     *  base prompt can't infer. Example for an M&A probe:
     *  "You're proposing exploratory M&A conversation with a
     *   succession-stage business owner. Lead with respect for
     *   what they've built; do NOT lead with valuation; the goal
     *   of first contact is to learn whether succession is on
     *   their mind, not to make an offer." Example for a
     *   procurement probe: "Standard supply-side first-touch — ask
     *   if they're the right contact for X; do not discuss pricing
     *   or terms."
     *
     *  NULL falls back to the base prompt's general framing
     *  (existing behavior — fuel-procurement probes need no extra
     *  hint since the base prompt was authored for them).
     *
     *  Capped at 1000 chars in the drafter to keep prompt size
     *  bounded; the schema doesn't enforce a length so operators
     *  can iterate. */
    domainHint: text('domain_hint'),

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

    /** Target justification (migration 0097). Operator (or agent)
     *  fills these in before promoting a target to drafted/queued.
     *  Phase 2H autopilot's daily-send queue filters on
     *  justificationState='justified' — research_only targets are
     *  never auto-drafted. */
    whyThisCompany: text('why_this_company'),
    whyThisPerson: text('why_this_person'),
    whyNow: text('why_now'),
    /** Array of evidence items the operator cites — { source, label,
     *  url? }. Pulled from evidenceJson + Apollo + atlas. */
    supportingSignals: jsonb('supporting_signals')
      .$type<Array<{ source: string; label: string; url?: string }>>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    /** The least-committal first ask. e.g. "are you the right person
     *  for supplier inquiries?" — never pricing/quantity/terms. */
    safestFirstAsk: text('safest_first_ask'),
    /** 'pending' | 'research_only' | 'justified'. Promotion gate. */
    justificationState: text('justification_state')
      .notNull()
      .default('pending'),

    /** Structured boolean signals (migration 0098, Phase 2E). Keyed
     *  by signal name → boolean. Joined against reply outcomes by
     *  the scorecard helper to compute signal validation. Canonical
     *  signal kinds (free text — taxonomy can grow additively):
     *    procurement_email_found, named_contact_found,
     *    imports_relevant_products, cold_storage,
     *    serves_hotels_restaurants, active_website, apollo_contact,
     *    recent_hiring, tender_or_procurement_signal */
    signalsPresent: jsonb('signals_present')
      .$type<Record<string, boolean>>()
      .notNull()
      .default({}),

    /** Phase 2I.4 — message variant assignment (migration 0102).
     *  Stamped by autopilot at draft time via weighted sampling among
     *  the probe's active variants. Nullable so targets created
     *  before variants existed fall back to the plan-derived intent
     *  string from Phase 2H. */
    variantId: text('variant_id'),

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
  /** Plan-generation status. Surfaces fallback paths so the operator
   *  knows when a plan was synthesized from a deterministic skeleton
   *  rather than the Sonnet pass — and so autopilot refuses to send
   *  outreach grounded in a hollow plan. Absent on plans created
   *  before this field landed; `setProbePlan` treats absent as 'ok'
   *  for back-compat. */
  generationStatus?: 'ok' | 'fallback_no_api_key' | 'fallback_parse_error';
  /** Short error snippet (LLM raw output prefix or env-var diagnosis)
   *  surfaced in the dashboard fallback banner. Only set when
   *  generationStatus !== 'ok'. */
  generationError?: string;
}

export interface ProbeTask {
  id: string;
  label: string;
  status: 'pending' | 'in_progress' | 'done' | 'skipped';
  completedAt?: string;
  result?: string;
}

/**
 * Probe ladder stages. Sequential 5-stage progression.
 *
 *   1. market_structure — who's here, who's the gatekeeper, what's
 *      the segment shape. Prerequisite for everything else.
 *   2. routing — first-touch routing emails ("are you the right
 *      person?"). Generates named contacts + reply patterns.
 *   3. pain_discovery — qualifying questions ("how do you currently
 *      handle X?"). Surfaces operator-relevant pain.
 *   4. commercial_qualification — pricing intent / volume
 *      indications / payment terms appetite.
 *   5. deal_room_conversion — formal LOI / NCNDA / fee discussions.
 *      Routes positive replies into a deal room.
 *
 * Hard discipline rule: agent cannot propose advancing past
 * `routing` until at least one routing-style reply has been received,
 * past `pain_discovery` until at least one qualifying-conversation
 * touchpoint exists, etc. Validation lives in the advance-stage
 * action; schema just stores. */
export const LADDER_STAGES = [
  'market_structure',
  'routing',
  'pain_discovery',
  'commercial_qualification',
  'deal_room_conversion',
] as const;
export type LadderStage = (typeof LADDER_STAGES)[number];

export const TARGET_JUSTIFICATION_STATES = [
  'pending',
  'research_only',
  'justified',
] as const;
export type TargetJustificationState =
  (typeof TARGET_JUSTIFICATION_STATES)[number];

/**
 * Canonical signal taxonomy for `market_probe_targets.signals_present`.
 * Free text in DB (taxonomy can grow additively without migration);
 * this constant lists the canonical kinds the scorecard reports on.
 */
export const PROBE_SIGNAL_KINDS = [
  'procurement_email_found',
  'named_contact_found',
  'imports_relevant_products',
  'cold_storage',
  'serves_hotels_restaurants',
  'active_website',
  'apollo_contact',
  'recent_hiring',
  'tender_or_procurement_signal',
] as const;
export type ProbeSignalKind = (typeof PROBE_SIGNAL_KINDS)[number];
