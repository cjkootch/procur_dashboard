import 'server-only';
import { and, desc, eq, sql } from 'drizzle-orm';
import {
  db,
  feedbackEvents,
  marketAtlasFacts,
  marketMapSegments,
  marketProbeHypotheses,
  marketProbeTargets,
  marketProbes,
  type MarketMapSegment,
  type NewMarketMapSegment,
  PROBE_SIGNAL_KINDS,
  type ProbeSignalKind,
} from '@procur/db';
import { createId } from '@procur/ai';

// Re-export the signal taxonomy so apps/app reads it via @procur/catalog.
export { PROBE_SIGNAL_KINDS };
export type { ProbeSignalKind };

/**
 * Phase 2E measurement helpers.
 *
 * Three concerns, one file:
 *   - Market map segments — per-(probe, segment) coverage tracking.
 *   - Signal attribution — write/read structured boolean flags per
 *     target; join against reply outcomes for validation.
 *   - Probe scorecard — read-only aggregator that synthesizes a
 *     composite snapshot from targets + atlas + hypotheses + map.
 *
 * Feedback shortcuts (Pattern 1 / Pattern 4 of the existing
 * feedback_events brief) ride on the existing helper surface;
 * `recordFeedbackShortcut` writes the row in the shape the existing
 * UI expects.
 */

// ──────────────────────────────────────────────────────────────────
// Market map segments
// ──────────────────────────────────────────────────────────────────

export interface UpsertSegmentInput {
  probeId: string;
  segmentName: string;
  estimatedTotal?: number | null;
  notes?: string | null;
}

export async function upsertSegment(
  input: UpsertSegmentInput,
): Promise<MarketMapSegment> {
  const row: NewMarketMapSegment = {
    id: createId(),
    probeId: input.probeId,
    segmentName: input.segmentName,
    estimatedTotal: input.estimatedTotal ?? null,
    notes: input.notes ?? null,
  };
  const [created] = await db
    .insert(marketMapSegments)
    .values(row)
    .onConflictDoUpdate({
      target: [
        marketMapSegments.probeId,
        marketMapSegments.segmentName,
      ],
      set: {
        estimatedTotal: sql`COALESCE(excluded.estimated_total, ${marketMapSegments.estimatedTotal})`,
        notes: sql`COALESCE(excluded.notes, ${marketMapSegments.notes})`,
        updatedAt: new Date(),
      },
    })
    .returning();
  if (!created) throw new Error('upsertSegment: no row returned');
  return created;
}

/**
 * Recompute identified / contacted / replied counts from
 * market_probe_targets. Cheap (single grouped query). Called by the
 * scorecard helper before reading; also exposed as an action so the
 * operator can force-refresh.
 */
export async function refreshSegmentCounts(probeId: string): Promise<void> {
  const counts = await db
    .select({
      segment: marketProbeTargets.segment,
      identified: sql<number>`COUNT(*)::int`,
      contacted: sql<number>`COUNT(*) FILTER (WHERE ${marketProbeTargets.sendStatus} IN ('sent','queued'))::int`,
      replied: sql<number>`COUNT(*) FILTER (WHERE ${marketProbeTargets.replyStatus} IS NOT NULL AND ${marketProbeTargets.replyStatus} <> 'none')::int`,
    })
    .from(marketProbeTargets)
    .where(eq(marketProbeTargets.probeId, probeId))
    .groupBy(marketProbeTargets.segment);

  for (const c of counts) {
    if (!c.segment) continue;
    await db
      .insert(marketMapSegments)
      .values({
        id: createId(),
        probeId,
        segmentName: c.segment,
        identifiedCount: c.identified,
        contactedCount: c.contacted,
        repliedCount: c.replied,
      })
      .onConflictDoUpdate({
        target: [
          marketMapSegments.probeId,
          marketMapSegments.segmentName,
        ],
        set: {
          identifiedCount: c.identified,
          contactedCount: c.contacted,
          repliedCount: c.replied,
          updatedAt: new Date(),
        },
      });
  }
}

export async function listSegments(
  probeId: string,
): Promise<MarketMapSegment[]> {
  return await db
    .select()
    .from(marketMapSegments)
    .where(eq(marketMapSegments.probeId, probeId))
    .orderBy(desc(marketMapSegments.identifiedCount));
}

// ──────────────────────────────────────────────────────────────────
// Signal attribution
// ──────────────────────────────────────────────────────────────────

/**
 * Set or update the structured signal flags for a target. Merges
 * with existing — passing `{ apollo_contact: true }` doesn't clear
 * other flags.
 */
export async function setTargetSignals(input: {
  targetId: string;
  signals: Record<string, boolean>;
}): Promise<void> {
  const [target] = await db
    .select({ signalsPresent: marketProbeTargets.signalsPresent })
    .from(marketProbeTargets)
    .where(eq(marketProbeTargets.id, input.targetId))
    .limit(1);
  if (!target) return;
  const merged = { ...(target.signalsPresent ?? {}), ...input.signals };
  await db
    .update(marketProbeTargets)
    .set({ signalsPresent: merged, updatedAt: new Date() })
    .where(eq(marketProbeTargets.id, input.targetId));
}

export interface SignalValidationRow {
  signal: string;
  withSignal: { sent: number; replied: number; positiveReplied: number };
  withoutSignal: { sent: number; replied: number; positiveReplied: number };
  /** Reply rate with the signal minus reply rate without. Positive
   *  delta = signal predicts reply; negative = signal is anti-predictive. */
  replyDelta: number;
}

/**
 * For a probe, join signal flags against reply outcomes — answers
 * "which signals predicted replies?" Used by the scorecard +
 * Learning Report. Iterates the canonical PROBE_SIGNAL_KINDS plus
 * any operator-introduced custom flags.
 */
export async function computeSignalValidation(
  probeId: string,
): Promise<SignalValidationRow[]> {
  const targets = await db
    .select({
      sendStatus: marketProbeTargets.sendStatus,
      replyStatus: marketProbeTargets.replyStatus,
      signalsPresent: marketProbeTargets.signalsPresent,
    })
    .from(marketProbeTargets)
    .where(eq(marketProbeTargets.probeId, probeId));

  // Discover the union of signal keys across all targets so custom
  // flags get reported alongside canonical ones.
  const keys = new Set<string>(PROBE_SIGNAL_KINDS);
  for (const t of targets) {
    for (const k of Object.keys(t.signalsPresent ?? {})) keys.add(k);
  }

  const rows: SignalValidationRow[] = [];
  for (const signal of keys) {
    const w = { sent: 0, replied: 0, positiveReplied: 0 };
    const wo = { sent: 0, replied: 0, positiveReplied: 0 };
    for (const t of targets) {
      const has = (t.signalsPresent ?? {})[signal] === true;
      const isSent =
        t.sendStatus === 'sent' || t.sendStatus === 'queued';
      const replied =
        t.replyStatus &&
        t.replyStatus !== 'none' &&
        t.replyStatus !== 'unsubscribe';
      const positive =
        t.replyStatus === 'positive' || t.replyStatus === 'routing';
      const bucket = has ? w : wo;
      if (isSent) bucket.sent += 1;
      if (replied) bucket.replied += 1;
      if (positive) bucket.positiveReplied += 1;
    }
    const wRate = w.sent > 0 ? w.replied / w.sent : 0;
    const woRate = wo.sent > 0 ? wo.replied / wo.sent : 0;
    rows.push({
      signal,
      withSignal: w,
      withoutSignal: wo,
      replyDelta: wRate - woRate,
    });
  }
  // Order: signals with most observations first (more reliable
  // attribution), within that by replyDelta desc.
  rows.sort((a, b) => {
    const aN = a.withSignal.sent + a.withoutSignal.sent;
    const bN = b.withSignal.sent + b.withoutSignal.sent;
    if (aN !== bN) return bN - aN;
    return b.replyDelta - a.replyDelta;
  });
  return rows;
}

// ──────────────────────────────────────────────────────────────────
// Probe scorecard
// ──────────────────────────────────────────────────────────────────

export interface ProbeScorecard {
  probeId: string;
  asOf: string;
  // Outreach metrics
  targetsTotal: number;
  targetsJustified: number;
  sentCount: number;
  repliedCount: number;
  positiveReplies: number;
  bouncedCount: number;
  unsubscribedCount: number;
  replyRate: number;
  routingRate: number;
  qualifiedInterestRate: number;
  bounceRate: number;
  unsubscribeRate: number;
  // Memory metrics
  atlasFactsCount: number;
  atlasNegativeRulesCount: number;
  hypothesesActive: number;
  hypothesesConfirmed: number;
  hypothesesFalsified: number;
  // Coverage
  segments: Array<{
    name: string;
    estimatedTotal: number | null;
    identified: number;
    contacted: number;
    replied: number;
    coveragePct: number | null;
  }>;
  // Signal attribution (top 5 by observation count)
  topSignals: SignalValidationRow[];
  // Composite (0-100 each; rough heuristic)
  scores: {
    riskCleanliness: number;
    marketStructureGain: number;
    dataQualityGain: number;
    signalValidation: number;
    overallLearning: number;
  };
}

/**
 * Compute the scorecard. Refreshes segment counts before reading so
 * the operator's view always reflects current target state.
 */
export async function computeProbeScorecard(
  probeId: string,
): Promise<ProbeScorecard | null> {
  const [probe] = await db
    .select()
    .from(marketProbes)
    .where(eq(marketProbes.id, probeId))
    .limit(1);
  if (!probe) return null;

  await refreshSegmentCounts(probeId);

  const targets = await db
    .select({
      sendStatus: marketProbeTargets.sendStatus,
      replyStatus: marketProbeTargets.replyStatus,
      disposition: marketProbeTargets.disposition,
      justificationState: marketProbeTargets.justificationState,
    })
    .from(marketProbeTargets)
    .where(eq(marketProbeTargets.probeId, probeId));

  const targetsTotal = targets.length;
  const targetsJustified = targets.filter(
    (t) => t.justificationState === 'justified',
  ).length;
  const sentCount = targets.filter(
    (t) => t.sendStatus === 'sent' || t.sendStatus === 'queued',
  ).length;
  const bouncedCount = targets.filter((t) => t.sendStatus === 'bounced').length;
  const repliedCount = targets.filter(
    (t) =>
      t.replyStatus &&
      t.replyStatus !== 'none' &&
      t.replyStatus !== 'unsubscribe',
  ).length;
  const positiveReplies = targets.filter(
    (t) => t.replyStatus === 'positive' || t.replyStatus === 'routing',
  ).length;
  const routingReplies = targets.filter(
    (t) => t.replyStatus === 'routing',
  ).length;
  const unsubscribedCount = targets.filter(
    (t) => t.replyStatus === 'unsubscribe',
  ).length;
  const qualified = targets.filter((t) => t.disposition === 'qualified')
    .length;

  const div = (n: number, d: number) => (d > 0 ? n / d : 0);
  const replyRate = div(repliedCount, sentCount);
  const routingRate = div(routingReplies, sentCount);
  const qualifiedInterestRate = div(qualified, sentCount);
  const bounceRate = div(bouncedCount, sentCount);
  const unsubscribeRate = div(unsubscribedCount, sentCount);

  // Atlas
  const atlasRows = await db
    .select({
      factType: marketAtlasFacts.factType,
    })
    .from(marketAtlasFacts)
    .where(eq(marketAtlasFacts.sourceProbeId, probeId));
  const atlasFactsCount = atlasRows.length;
  const atlasNegativeRulesCount = atlasRows.filter(
    (r) => r.factType === 'negative_rule',
  ).length;

  // Hypotheses
  const hypotheses = await db
    .select({ status: marketProbeHypotheses.status })
    .from(marketProbeHypotheses)
    .where(eq(marketProbeHypotheses.probeId, probeId));
  const hypothesesActive = hypotheses.filter((h) => h.status === 'active')
    .length;
  const hypothesesConfirmed = hypotheses.filter(
    (h) => h.status === 'confirmed',
  ).length;
  const hypothesesFalsified = hypotheses.filter(
    (h) => h.status === 'falsified',
  ).length;

  // Segments
  const segs = await listSegments(probeId);
  const segments = segs.map((s) => ({
    name: s.segmentName,
    estimatedTotal: s.estimatedTotal,
    identified: s.identifiedCount,
    contacted: s.contactedCount,
    replied: s.repliedCount,
    coveragePct:
      s.estimatedTotal && s.estimatedTotal > 0
        ? Math.round((s.contactedCount / s.estimatedTotal) * 100)
        : null,
  }));

  // Signal validation — top 5 by observation count.
  const signalRows = await computeSignalValidation(probeId);
  const topSignals = signalRows.slice(0, 5);

  // Composite scores. Heuristics; refined as ground-truth lands.
  const riskCleanliness = Math.round(
    Math.max(0, 100 - bounceRate * 100 * 5 - unsubscribeRate * 100 * 5),
  );
  const marketStructureGain = Math.min(
    100,
    Math.round(atlasFactsCount * 8),
  );
  const dataQualityGain = Math.min(
    100,
    Math.round(targetsJustified * 4),
  );
  // Signal validation: % of canonical signals with a measured
  // positive replyDelta + sufficient observations.
  const validatedSignals = signalRows.filter(
    (s) => s.replyDelta > 0.05 && s.withSignal.sent + s.withoutSignal.sent >= 5,
  ).length;
  const signalValidation = Math.min(
    100,
    Math.round((validatedSignals / Math.max(1, PROBE_SIGNAL_KINDS.length)) * 100),
  );
  const overallLearning = Math.round(
    (riskCleanliness * 0.15 +
      marketStructureGain * 0.3 +
      dataQualityGain * 0.2 +
      signalValidation * 0.2 +
      Math.min(100, hypothesesConfirmed * 25 + hypothesesFalsified * 15) *
        0.15),
  );

  return {
    probeId,
    asOf: new Date().toISOString(),
    targetsTotal,
    targetsJustified,
    sentCount,
    repliedCount,
    positiveReplies,
    bouncedCount,
    unsubscribedCount,
    replyRate,
    routingRate,
    qualifiedInterestRate,
    bounceRate,
    unsubscribeRate,
    atlasFactsCount,
    atlasNegativeRulesCount,
    hypothesesActive,
    hypothesesConfirmed,
    hypothesesFalsified,
    segments,
    topSignals,
    scores: {
      riskCleanliness,
      marketStructureGain,
      dataQualityGain,
      signalValidation,
      overallLearning,
    },
  };
}

// ──────────────────────────────────────────────────────────────────
// Feedback shortcuts (one-click labels on targets)
// ──────────────────────────────────────────────────────────────────

export const PROBE_FEEDBACK_LABELS = [
  'good_target',
  'bad_target',
  'wrong_person',
  'wrong_segment',
  'weak_evidence',
  'good_angle',
  'too_generic',
  'too_aggressive',
  'create_lead',
  'create_deal_room',
  'suppress',
  'try_later',
] as const;
export type ProbeFeedbackLabel = (typeof PROBE_FEEDBACK_LABELS)[number];

const NEGATIVE_LABELS = new Set<ProbeFeedbackLabel>([
  'bad_target',
  'wrong_person',
  'wrong_segment',
  'weak_evidence',
  'too_generic',
  'too_aggressive',
  'suppress',
]);

const POSITIVE_LABELS = new Set<ProbeFeedbackLabel>([
  'good_target',
  'good_angle',
  'create_lead',
  'create_deal_room',
]);

/**
 * Write a one-click label as a feedback_events row. Reuses the
 * existing Pattern 1 / Pattern 4 schema — match_quality kind for
 * target-level labels, payload carries probe_id + target_id +
 * label string. sentiment is derived so the existing feedback
 * dashboards classify these alongside other operator feedback.
 *
 * Some labels have side effects (Phase 2F+ will wire them):
 *   create_lead       — queue propose_create_lead
 *   create_deal_room  — queue propose_create_deal
 *   suppress          — write entity_dispositions disposition='dead_end'
 * Phase 2E only writes the feedback row; downstream wires the side
 * effects in Phase 2F (feedback drives the playbook generator).
 */
export async function recordFeedbackShortcut(input: {
  probeId: string;
  targetId: string;
  label: ProbeFeedbackLabel;
  userId: string | null;
  note?: string;
}): Promise<void> {
  const sentiment = NEGATIVE_LABELS.has(input.label)
    ? 'negative'
    : POSITIVE_LABELS.has(input.label)
      ? 'positive'
      : 'neutral';
  await db.insert(feedbackEvents).values({
    userId: input.userId,
    feedbackKind: 'match_quality',
    targetType: 'probe_target',
    targetId: input.targetId,
    sentiment,
    payload: {
      probe_id: input.probeId,
      label: input.label,
      ...(input.note ? { note: input.note } : {}),
    },
    context: { surface: 'market_probe_target_row' },
  });
}

/**
 * List recent feedback shortcuts for a probe — feeds the learning
 * report ("which targets the operator marked as bad") + future
 * playbook generation ("learn from operator's wrong_segment labels").
 */
export async function listProbeFeedbackShortcuts(probeId: string) {
  return await db
    .select()
    .from(feedbackEvents)
    .where(
      and(
        eq(feedbackEvents.feedbackKind, 'match_quality'),
        eq(feedbackEvents.targetType, 'probe_target'),
        sql`${feedbackEvents.payload}->>'probe_id' = ${probeId}`,
      ),
    )
    .orderBy(desc(feedbackEvents.createdAt))
    .limit(200);
}
