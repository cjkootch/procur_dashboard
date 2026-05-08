import 'server-only';
import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import {
  approvals,
  db,
  marketProbeTargets,
  marketProbes,
  rvmAudioAssets,
  type MarketProbe,
} from '@procur/db';
import { computeProbeScorecard } from './market-probe-measurement';
import { listStrategyProposals } from './market-probe-strategy';

/**
 * Market Portfolio data layer. Aggregates per-probe metrics + signals
 * + needs-Cole reasons across all active / planning probes so the
 * /market-portfolio page can render one row per probe.
 *
 * Read-only — no new outreach capability. Composes existing helpers
 * (scorecard, strategy proposals, approvals queue) and adds a few
 * cheap counts (sentToday, per-channel approvals, RVM audio
 * presence) the scorecard doesn't already cover.
 */

export type PortfolioSignalLevel =
  | 'early'
  | 'weak'
  | 'promising'
  | 'winning'
  | 'risky';

export interface PortfolioRow {
  // Probe basics
  id: string;
  marketName: string;
  country: string | null;
  /** Free-text domain tag (probes' equivalent of discoveryDomain). */
  domain: string | null;
  status: string;
  mode: string;
  tier: number;
  ladderStage: string;
  allowedChannels: string[];
  dailySendLimit: number;
  totalSendLimit: number;

  // Send counts
  sentToday: number;
  totalSent: number;
  emailSent: number;
  leadFormsSubmitted: number;
  rvmDispatched: number;

  // Reply counts
  replies: number;
  routingReplies: number;
  positiveReplies: number;
  bounced: number;
  unsubscribed: number;

  // Composite scores (0-100)
  overallLearningScore: number;
  riskCleanlinessScore: number;

  // Derived
  signalLevel: PortfolioSignalLevel;
  recommendation: string;
  needsColeReasons: string[];

  // Internal counts used to derive needsCole — kept on the row so the
  // UI can render the same numbers without re-fetching.
  pendingStrategyProposals: number;
  pendingApprovals: number;
  hypothesesActive: number;
  hasRvmAudio: boolean;
  planGenerationStatus: string | undefined;
}

const ACTIVE_STATUSES = ['active', 'planning'] as const;

const HIGH_BOUNCE_THRESHOLD = 0.08;
const WEAK_OUTBOUND_THRESHOLD = 10;

/**
 * Top-level fetch. One row per active/planning probe with all the
 * fields the portfolio page renders. Sequential per-probe sub-queries
 * could fan out further but the probe count is small (single-tenant
 * deployment, dozens not thousands) so simple Promise.all is fine.
 */
export async function listMarketPortfolioRows(): Promise<PortfolioRow[]> {
  const probes = await db
    .select()
    .from(marketProbes)
    .where(
      inArray(marketProbes.status, ACTIVE_STATUSES as unknown as string[]),
    )
    .orderBy(desc(marketProbes.updatedAt));
  if (probes.length === 0) return [];

  return Promise.all(probes.map((p) => buildPortfolioRow(p)));
}

async function buildPortfolioRow(probe: MarketProbe): Promise<PortfolioRow> {
  const [
    scorecard,
    sentTodayRow,
    routingReplyRow,
    perChannelRows,
    strategyProposals,
    pendingApprovalsRow,
    rvmAudioActive,
  ] = await Promise.all([
    computeProbeScorecard(probe.id),
    db
      .select({
        sentToday: sql<number>`COUNT(*) FILTER (WHERE ${marketProbeTargets.sendStatus} = 'sent' AND ${marketProbeTargets.lastTouchAt} > NOW() - INTERVAL '24 hours')::int`,
      })
      .from(marketProbeTargets)
      .where(eq(marketProbeTargets.probeId, probe.id)),
    db
      .select({
        routing: sql<number>`COUNT(*) FILTER (WHERE ${marketProbeTargets.replyStatus} = 'routing')::int`,
      })
      .from(marketProbeTargets)
      .where(eq(marketProbeTargets.probeId, probe.id)),
    perChannelApprovalCounts(probe.id),
    listStrategyProposals(probe.id, { status: 'proposed' }),
    db
      .select({
        pending: sql<number>`COUNT(*)::int`,
      })
      .from(approvals)
      .where(
        and(
          eq(approvals.decision, 'pending'),
          sql`${approvals.proposedPayload}->>'market_probe_id' = ${probe.id}`,
        ),
      ),
    rvmAudioPresent(probe.id),
  ]);

  const sentToday = sentTodayRow[0]?.sentToday ?? 0;
  const routingReplies = routingReplyRow[0]?.routing ?? 0;
  const pendingApprovals = pendingApprovalsRow[0]?.pending ?? 0;

  const totalSent = scorecard?.sentCount ?? 0;
  const replies = scorecard?.repliedCount ?? 0;
  const positiveReplies = scorecard?.positiveReplies ?? 0;
  const bounced = scorecard?.bouncedCount ?? 0;
  const unsubscribed = scorecard?.unsubscribedCount ?? 0;
  const overallLearning = scorecard?.scores.overallLearning ?? 0;
  const riskCleanliness = scorecard?.scores.riskCleanliness ?? 100;
  const hypothesesActive = scorecard?.hypothesesActive ?? 0;
  const bounceRate = scorecard?.bounceRate ?? 0;

  // Risk gate: bounce rate over operator-set threshold (default 8%)
  // OR any unsubscribes OR paused status flag the safety gate uses.
  const maxBounceRate = Number(probe.maxBounceRatePct) / 100;
  const bounceBreach = bounceRate > Math.min(maxBounceRate, HIGH_BOUNCE_THRESHOLD);
  const isPaused = probe.status === 'paused';
  const riskyConditions = bounceBreach || unsubscribed > 0 || isPaused;

  const positiveOrRouting = positiveReplies + routingReplies;

  const signalLevel: PortfolioSignalLevel = (() => {
    if (riskyConditions) return 'risky';
    if (positiveOrRouting >= 2 && riskCleanliness >= 90) return 'winning';
    if (positiveOrRouting >= 1 || overallLearning > 60) return 'promising';
    if (totalSent >= WEAK_OUTBOUND_THRESHOLD && positiveOrRouting === 0)
      return 'weak';
    return 'early';
  })();

  const recommendation = recommendationFor(signalLevel, {
    pendingApprovals,
    pendingStrategyProposals: strategyProposals.length,
    totalSent,
    bounceBreach,
    isPaused,
  });

  const planGenerationStatus = (probe.planJson as { generationStatus?: string })
    ?.generationStatus;

  const needsColeReasons = computeNeedsCole({
    probe,
    pendingStrategyProposals: strategyProposals.length,
    pendingApprovals,
    isPaused,
    planGenerationStatus,
    hypothesesActive,
    bounceBreach,
    unsubscribed,
    hasRvmAudio: rvmAudioActive,
  });

  return {
    id: probe.id,
    marketName: probe.marketName,
    country: probe.country,
    domain: probe.domain ?? null,
    status: probe.status,
    mode: probe.mode,
    tier: probe.tier,
    ladderStage: probe.ladderStage,
    allowedChannels: probe.allowedChannels ?? [],
    dailySendLimit: probe.dailySendLimit,
    totalSendLimit: probe.totalSendLimit,
    sentToday,
    totalSent,
    emailSent: perChannelRows.email,
    leadFormsSubmitted: perChannelRows.leadForm,
    rvmDispatched: perChannelRows.rvm,
    replies,
    routingReplies,
    positiveReplies,
    bounced,
    unsubscribed,
    overallLearningScore: overallLearning,
    riskCleanlinessScore: riskCleanliness,
    signalLevel,
    recommendation,
    needsColeReasons,
    pendingStrategyProposals: strategyProposals.length,
    pendingApprovals,
    hypothesesActive,
    hasRvmAudio: rvmAudioActive,
    planGenerationStatus,
  };
}

/** Approvals keyed on the probe id in proposedPayload, grouped by
 *  actionType — the autopilot stamps market_probe_id into the
 *  payload of every email.send / lead_form.submit / rvm.dispatch
 *  approval it queues, so this counts all dispatches (auto-approved
 *  + operator-approved + still-pending — anything that GOT proposed). */
async function perChannelApprovalCounts(probeId: string): Promise<{
  email: number;
  leadForm: number;
  rvm: number;
}> {
  const rows = await db
    .select({
      actionType: approvals.actionType,
      count: sql<number>`COUNT(*)::int`,
    })
    .from(approvals)
    .where(
      and(
        sql`${approvals.proposedPayload}->>'market_probe_id' = ${probeId}`,
        inArray(approvals.actionType, [
          'email.send',
          'lead_form.submit',
          'rvm.dispatch',
        ]),
      ),
    )
    .groupBy(approvals.actionType);
  let email = 0;
  let leadForm = 0;
  let rvm = 0;
  for (const r of rows) {
    if (r.actionType === 'email.send') email = r.count;
    else if (r.actionType === 'lead_form.submit') leadForm = r.count;
    else if (r.actionType === 'rvm.dispatch') rvm = r.count;
  }
  return { email, leadForm, rvm };
}

async function rvmAudioPresent(probeId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: rvmAudioAssets.id })
    .from(rvmAudioAssets)
    .where(
      and(
        eq(rvmAudioAssets.probeId, probeId),
        eq(rvmAudioAssets.isActive, true),
      ),
    )
    .limit(1);
  return Boolean(row);
}

function recommendationFor(
  level: PortfolioSignalLevel,
  ctx: {
    pendingApprovals: number;
    pendingStrategyProposals: number;
    totalSent: number;
    bounceBreach: boolean;
    isPaused: boolean;
  },
): string {
  if (ctx.pendingApprovals > 0)
    return `${ctx.pendingApprovals} pending approval${ctx.pendingApprovals === 1 ? '' : 's'} — review the queue.`;
  if (ctx.pendingStrategyProposals > 0)
    return `${ctx.pendingStrategyProposals} strategy proposal${ctx.pendingStrategyProposals === 1 ? '' : 's'} pending review.`;
  if (ctx.bounceBreach) return 'Bounce rate breached threshold — pause + investigate.';
  if (ctx.isPaused) return 'Paused — review kill criteria + resume when safe.';
  switch (level) {
    case 'winning':
      return 'Multiple positive replies + clean risk. Consider promoting toward commercial qualification.';
    case 'promising':
      return 'Early positive signal. Keep iterating — refine targets / messaging.';
    case 'weak':
      return `${ctx.totalSent}+ attempts, no replies. Reconsider segments or angle before more sends.`;
    case 'risky':
      return 'Risk gate tripped — pause + audit before more sends.';
    case 'early':
    default:
      return 'Insufficient signal yet — let the next batch run.';
  }
}

function computeNeedsCole(input: {
  probe: MarketProbe;
  pendingStrategyProposals: number;
  pendingApprovals: number;
  isPaused: boolean;
  planGenerationStatus: string | undefined;
  hypothesesActive: number;
  bounceBreach: boolean;
  unsubscribed: number;
  hasRvmAudio: boolean;
}): string[] {
  const reasons: string[] = [];
  if (input.pendingApprovals > 0) {
    reasons.push(
      `${input.pendingApprovals} outbound approval${input.pendingApprovals === 1 ? '' : 's'} pending`,
    );
  }
  if (input.pendingStrategyProposals > 0) {
    reasons.push(
      `${input.pendingStrategyProposals} strategy proposal${input.pendingStrategyProposals === 1 ? '' : 's'} awaiting review`,
    );
  }
  if (input.isPaused) {
    reasons.push('Paused — likely by safety / kill criteria');
  }
  if (
    input.planGenerationStatus &&
    input.planGenerationStatus !== 'ok'
  ) {
    reasons.push(`Plan generation fallback: ${input.planGenerationStatus}`);
  }
  if (input.hypothesesActive === 0) {
    reasons.push('No active hypotheses');
  }
  if (input.bounceBreach) {
    reasons.push('Bounce rate over threshold');
  }
  if (input.unsubscribed > 0) {
    reasons.push(
      `${input.unsubscribed} unsubscribe${input.unsubscribed === 1 ? '' : 's'} recorded`,
    );
  }
  if (
    (input.probe.allowedChannels ?? []).includes('rvm') &&
    !input.hasRvmAudio
  ) {
    reasons.push('RVM enabled but no active audio asset');
  }
  // NOTE for v1: high-skip-rate detection, no-eligible-channel, and
  // unattributed-lead-form-replies are not yet tracked in
  // structured form. They land in autopilot return values and inbox
  // logs but no persisted counter. Adding those is a separate
  // capture-the-signal PR.
  return reasons;
}

/** Aggregate count for the dashboard header pill ("3 probes need
 *  Cole"). Cheap because it just sums across rows we already
 *  fetched. */
export function countProbesNeedingCole(rows: PortfolioRow[]): number {
  return rows.filter((r) => r.needsColeReasons.length > 0).length;
}

// Suppress unused-import lint when only types are consumed downstream.
void gte;
