'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { and, eq, inArray } from 'drizzle-orm';
import { db, knownEntities, marketProbes } from '@procur/db';
import { requireCompany } from '@procur/auth';
import { createId } from '@procur/ai';
import {
  addApolloLookalikesToProbe,
  addAtlasFact,
  addThesisDrivenApolloOrgsToProbe,
  advanceProbeLadder,
  approveStrategyProposal,
  autopilotSendBatch,
  bulkInsertHypotheses,
  computeProbeScorecard,
  createProbe,
  createVariant,
  setVariantStatus,
  type VariantStatus,
  findDecisionMakersForTarget,
  getProbe,
  insertHypothesis,
  getLatestLearningReport,
  insertLearningReport,
  insertStrategyProposal,
  listAtlasFacts,
  listAtlasFactsForProbe,
  listHypothesesForProbe,
  listProbeFeedbackShortcuts,
  listRejectionHistory,
  listSegments,
  listStrategyProposals,
  listTargetsForProbe,
  markProbeTaskStatus,
  recordFeedbackShortcut,
  rejectStrategyProposal,
  resolveHypothesis,
  savePlaybookFromProbe,
  setPlaybookStatus,
  setProbePlan,
  setProbeStatus,
  setTargetJustification,
  setTargetResearchOnly,
  setTargetSignals,
  upsertProbeTargets,
  upsertSegment,
  recommendCommunicationTargets,
  ATLAS_FACT_TYPES,
  type AtlasFactType,
  type HypothesisStatus,
  type HypothesisType,
  type LearningReportPayload,
  type ProbeFeedbackLabel,
} from '@procur/catalog';
import {
  generateLearningReport,
  generateProbePlan,
  proposeProbeStrategyAdjustments,
  type ProbeMetricsSnapshot,
} from '@procur/ai';

/**
 * Server actions for the Market Probes UI. Each action returns void
 * (per Next App Router convention for `<form action={...}>`); the
 * page revalidates after each call so the dashboard reflects the new
 * state.
 *
 * Discipline: actions OWN the side effects. The components below them
 * stay declarative (read settings, render). Server actions are the
 * only place that mutates probes / writes to the DB / calls the LLM.
 */

function str(formData: FormData, key: string): string | null {
  const v = formData.get(key);
  if (v == null) return null;
  const s = String(v).trim();
  return s.length > 0 ? s : null;
}

function int(formData: FormData, key: string): number | null {
  const v = str(formData, key);
  if (!v) return null;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

function csv(formData: FormData, key: string): string[] {
  const v = str(formData, key);
  if (!v) return [];
  return v
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Create a probe + redirect to its detail page. The detail page's
 * "Generate plan" button calls the LLM separately so the create form
 * stays fast.
 */
export async function createProbeAction(formData: FormData): Promise<void> {
  const { user } = await requireCompany();

  const marketName = str(formData, 'marketName');
  const productThesis = str(formData, 'productThesis');
  if (!marketName || !productThesis) {
    throw new Error('marketName and productThesis required');
  }

  const id = createId();
  await createProbe({
    id,
    marketName,
    country: str(formData, 'country'),
    productThesis,
    riskLevel: (str(formData, 'riskLevel') as 'low' | 'medium' | 'high') ?? 'low',
    objective: str(formData, 'objective'),
    allowedChannels: csv(formData, 'allowedChannels').length > 0
      ? csv(formData, 'allowedChannels')
      : ['email'],
    allowedSegments: csv(formData, 'allowedSegments'),
    blockedTerms: csv(formData, 'blockedTerms'),
    dailySendLimit: int(formData, 'dailySendLimit') ?? 10,
    totalSendLimit: int(formData, 'totalSendLimit') ?? 50,
    createdBy: user.id,
  });

  revalidatePath('/market-probes');
  redirect(`/market-probes/${id}`);
}

/**
 * Run the plan-generation pass for a probe. One Sonnet call; result
 * replaces probe.plan_json. Status flips planning → active inside
 * setProbePlan so the dashboard updates the badge.
 */
export async function generatePlanAction(formData: FormData): Promise<void> {
  await requireCompany();
  const probeId = str(formData, 'probeId');
  if (!probeId) throw new Error('probeId required');

  const probe = await getProbe(probeId);
  if (!probe) throw new Error('probe not found');

  // Pull rejection history so a regeneration after rejected proposals
  // doesn't re-propose the same pivots — the agent sees the
  // operator's feedback and adapts. First plan generation has empty
  // history; later regenerations carry the learning forward.
  const rejectionHistory = await listRejectionHistory(probeId);

  // Pull negative rules from the atlas (any prior probe in this
  // country that wrote prescriptive constraints). HONOR rules ride
  // into the plan-gen prompt so the agent doesn't propose a
  // strategy a prior probe already learned not to do.
  const negativeRules = probe.country
    ? (
        await listAtlasFacts({
          country: probe.country,
          factType: 'negative_rule',
        })
      )
        .map((f) => f.ruleText)
        .filter((s): s is string => Boolean(s && s.trim().length > 0))
    : [];

  const result = await generateProbePlan({
    marketName: probe.marketName,
    country: probe.country,
    productThesis: probe.productThesis,
    riskLevel: probe.riskLevel as 'low' | 'medium' | 'high',
    objective: probe.objective,
    allowedChannels: probe.allowedChannels,
    dailySendLimit: probe.dailySendLimit,
    totalSendLimit: probe.totalSendLimit,
    ladderStage: probe.ladderStage as
      | 'market_structure'
      | 'routing'
      | 'pain_discovery'
      | 'commercial_qualification'
      | 'deal_room_conversion',
    rejectionHistory: rejectionHistory.map((r) => ({
      proposalType: r.proposalType,
      rationale: r.rationale,
      feedback: r.feedback,
      rejectedAt: r.rejectedAt.toISOString(),
    })),
    negativeRules,
  });

  await setProbePlan(probeId, result.plan);
  if (result.hypotheses.length > 0) {
    // First plan-gen: bulk-insert. Subsequent regenerations also
    // append (operators rarely re-run with the same hypotheses
    // surviving; if they want clean state they can resolve the old
    // ones to 'abandoned' first).
    await bulkInsertHypotheses(probeId, result.hypotheses);
  }
  revalidatePath(`/market-probes/${probeId}`);
}

/**
 * Operator acknowledges a fallback-generated plan and unblocks
 * autopilot. Used when the plan came back from the deterministic
 * skeleton path (no API key / parse error) and the operator has
 * reviewed/edited the plan manually and wants to proceed anyway.
 * Clears the generationStatus + generationError fields and flips
 * status planning → active.
 */
export async function approveFallbackPlanAction(
  formData: FormData,
): Promise<void> {
  await requireCompany();
  const probeId = str(formData, 'probeId');
  if (!probeId) throw new Error('probeId required');

  const probe = await getProbe(probeId);
  if (!probe) throw new Error('probe not found');
  if (!probe.planJson?.generationStatus) {
    // Already clean — no-op (idempotent so a stale UI button click
    // doesn't error).
    return;
  }
  // Strip the fallback markers and re-run setProbePlan, which now
  // sees a clean plan and flips status to 'active'.
  const {
    generationStatus: _drop,
    generationError: _drop2,
    ...cleanPlan
  } = probe.planJson;
  void _drop;
  void _drop2;
  await setProbePlan(probeId, { ...cleanPlan, generationStatus: 'ok' });
  revalidatePath(`/market-probes/${probeId}`);
}

/**
 * Run target discovery for a probe. Reuses
 * `recommendCommunicationTargets` (the existing intelligence-graph
 * ranker) with the probe's market as a country filter. Inserts the
 * top-N candidates into `market_probe_targets` with fit_tier mapped
 * from `nextBestAction`. Marks the `identify_targets` task done.
 *
 * Phase 1 takes the top 25 candidates regardless of segment. Phase 2
 * will multi-seed from the operator-approved segment list.
 */
export async function discoverTargetsAction(formData: FormData): Promise<void> {
  await requireCompany();
  const probeId = str(formData, 'probeId');
  if (!probeId) throw new Error('probeId required');

  const probe = await getProbe(probeId);
  if (!probe) throw new Error('probe not found');

  // Country fence: most probes scope to a single ISO-2; pass it as a
  // hard filter so the recommender doesn't drift outside the sandbox.
  // The recommender accepts filter-only mode (no seed) for fresh
  // probes — see the small relaxation in
  // packages/catalog/src/communication-recommendations.ts.
  if (!probe.country) {
    throw new Error(
      'probe.country required for target discovery — set it on the probe and retry',
    );
  }
  const filters = { country: probe.country.toUpperCase() };

  let candidates = await recommendCommunicationTargets({
    limit: 25,
    filters,
  });

  // Phase 2G safety net: drop any candidates flagged
  // scout_protection=true on known_entities. Strategic relationships
  // and sensitive counterparties should never appear in autonomous
  // probe target queues. Single batch lookup against the candidate
  // set so this stays cheap.
  if (candidates.length > 0) {
    const slugs = candidates.map((c) => c.entitySlug);
    const protectedRows = await db
      .select({ slug: knownEntities.slug })
      .from(knownEntities)
      .where(
        and(
          inArray(knownEntities.slug, slugs),
          eq(knownEntities.scoutProtection, true),
        ),
      );
    const protectedSet = new Set(protectedRows.map((r) => r.slug));
    candidates = candidates.filter((c) => !protectedSet.has(c.entitySlug));
  }

  if (candidates.length === 0) {
    // No candidates yet — surface the empty result clearly. Mark the
    // task in_progress so the operator knows it ran but produced
    // nothing actionable. They can refine the country/segments and
    // re-run.
    await markProbeTaskStatus(
      probeId,
      'identify_targets',
      'in_progress',
      'Recommender returned 0 candidates — refine market/segments and retry.',
    );
    revalidatePath(`/market-probes/${probeId}`);
    return;
  }

  const targets = candidates.map((c) => ({
    id: createId(),
    entitySlug: c.entitySlug,
    contactId: null,
    segment: null,
    fitTier:
      c.nextBestAction === 'outreach_ready'
        ? ('A' as const)
        : c.nextBestAction === 'research_target'
          ? ('B' as const)
          : c.nextBestAction === 'compliance_blocked'
            ? ('D' as const)
            : ('C' as const),
    confidence: c.score / 100,
    evidenceJson: {
      score: c.score,
      scoreBreakdown: c.scoreBreakdown,
      evidenceItems: c.evidenceItems,
      risks: c.risks,
      recommendedChannel: c.recommendedChannel,
      entityName: c.entityName,
      nextBestAction: c.nextBestAction,
    },
  }));

  const inserted = await upsertProbeTargets(probeId, targets);
  await markProbeTaskStatus(
    probeId,
    'identify_targets',
    'done',
    `Identified ${inserted} target${inserted === 1 ? '' : 's'}.`,
  );
  revalidatePath(`/market-probes/${probeId}`);
}

export async function setProbeStatusAction(formData: FormData): Promise<void> {
  await requireCompany();
  const probeId = str(formData, 'probeId');
  const status = str(formData, 'status') as
    | 'planning'
    | 'active'
    | 'paused'
    | 'completed'
    | 'abandoned'
    | null;
  if (!probeId || !status) throw new Error('probeId + status required');
  await setProbeStatus(probeId, status);
  revalidatePath(`/market-probes/${probeId}`);
  revalidatePath('/market-probes');
}

/**
 * Apollo lookalikes — given an operator-picked seed (a known_entities
 * slug already enriched from Apollo), find attribute-similar orgs via
 * the Apollo search endpoint and add them as probe targets. Hard-fenced
 * by probe.country so lookalikes don't drift outside the sandbox.
 *
 * The helper is idempotent on (probe_id, entity_slug) so re-running
 * with the same seed just refreshes evidence.
 */
export async function addApolloLookalikesAction(
  formData: FormData,
): Promise<void> {
  await requireCompany();
  const probeId = str(formData, 'probeId');
  const seedSlug = str(formData, 'seedSlug');
  if (!probeId || !seedSlug) throw new Error('probeId + seedSlug required');

  const result = await addApolloLookalikesToProbe({
    probeId,
    seedSlug,
    limit: int(formData, 'limit') ?? 25,
  });

  // Whether ok or not, advance the identify_targets task so the
  // operator sees the run was attempted. The task result text carries
  // the status — successful runs name the count, failures name the
  // reason. Operator can re-run anytime.
  if (result.ok) {
    await markProbeTaskStatus(
      probeId,
      'identify_targets',
      result.targetsCreated > 0 ? 'done' : 'in_progress',
      `Apollo lookalikes (seed ${seedSlug}): ${result.candidatesFound} candidate${result.candidatesFound === 1 ? '' : 's'} found, ${result.targetsCreated} added${result.stubsCreated > 0 ? ` (${result.stubsCreated} new rolodex stub${result.stubsCreated === 1 ? '' : 's'})` : ''}.`,
    );
  } else {
    await markProbeTaskStatus(
      probeId,
      'identify_targets',
      'in_progress',
      `Apollo lookalikes (seed ${seedSlug}): ${result.error}`,
    );
  }
  revalidatePath(`/market-probes/${probeId}`);
}

/**
 * Thesis-driven Apollo search — seed-free org discovery. Operator
 * supplies a few keyword tags; probe.country fences geography. Useful
 * when no rolodex seed exists yet.
 */
export async function addThesisOrgsAction(formData: FormData): Promise<void> {
  await requireCompany();
  const probeId = str(formData, 'probeId');
  if (!probeId) throw new Error('probeId required');

  // Free-form input — split on commas/newlines so the operator can
  // type "hotel procurement, fuel distributor" or paste a list.
  const raw = str(formData, 'keywords');
  const keywords = raw
    ? raw
        .split(/[,\n]/)
        .map((s) => s.trim())
        .filter(Boolean)
    : [];

  const result = await addThesisDrivenApolloOrgsToProbe({
    probeId,
    keywords,
    limit: int(formData, 'limit') ?? 25,
  });

  if (result.ok) {
    await markProbeTaskStatus(
      probeId,
      'identify_targets',
      result.targetsCreated > 0 ? 'done' : 'in_progress',
      `Apollo thesis search ([${keywords.join(', ')}], ${(await getProbe(probeId))?.country}): ${result.candidatesFound} candidate${result.candidatesFound === 1 ? '' : 's'} found, ${result.targetsCreated} added${result.stubsCreated > 0 ? ` (${result.stubsCreated} new stub${result.stubsCreated === 1 ? '' : 's'})` : ''}.`,
    );
  } else {
    await markProbeTaskStatus(
      probeId,
      'identify_targets',
      'in_progress',
      `Apollo thesis search: ${result.error}`,
    );
  }
  revalidatePath(`/market-probes/${probeId}`);
}

/**
 * Per-target decision-maker discovery via Apollo searchPeople.
 * Results auto-persist to entity_contact_enrichments (Apollo wrapper
 * handles this) so the entity-profile Decision-makers panel reflects
 * the new candidates. Marks find_contacts task done if results land.
 */
export async function findDecisionMakersAction(
  formData: FormData,
): Promise<void> {
  const { company } = await requireCompany();
  const targetId = str(formData, 'targetId');
  const probeId = str(formData, 'probeId');
  if (!targetId || !probeId) throw new Error('targetId + probeId required');

  const result = await findDecisionMakersForTarget({
    targetId,
    companyId: company.id,
    perPage: 25,
  });

  if (result.ok && result.candidatesFound > 0) {
    const sourceTag =
      result.source === 'rolodex'
        ? ' via rolodex fallback (Apollo unavailable / no coverage — names + titles only, no email-verification status)'
        : '';
    await markProbeTaskStatus(
      probeId,
      'find_contacts',
      'done',
      `${result.candidatesFound} decision-maker candidate${result.candidatesFound === 1 ? '' : 's'} found for ${result.entitySlug}${sourceTag}; see entity profile Decision-makers panel.`,
    );
  }
  revalidatePath(`/market-probes/${probeId}`);
}

// ────────────────────────────────────────────────────────────────
// Phase 2C — market atlas + strategy adaptation
// ────────────────────────────────────────────────────────────────

/**
 * Add an operator-written atlas fact. Authored_by='operator' →
 * confidence defaults 0.9 in the catalog helper. The fact persists
 * across probes — next Caribbean food probe sees this one's facts.
 */
export async function addAtlasFactAction(
  formData: FormData,
): Promise<void> {
  const { user } = await requireCompany();
  const probeId = str(formData, 'probeId');
  const country = str(formData, 'country');
  const factType = str(formData, 'factType');
  const description = str(formData, 'description');
  if (!country || !factType || !description) {
    throw new Error('country + factType + description required');
  }
  // Server-side validation against the canonical taxonomy. The form
  // <select> already constrains operator clicks; this catches typos
  // from alternate form posts (e.g. chat-tool emissions in the
  // future, or bookmarks). Atlas reads filter on exact fact_type
  // match, so a typo silently disappears from listings without this
  // guard.
  if (!ATLAS_FACT_TYPES.includes(factType as AtlasFactType)) {
    throw new Error(
      `factType "${factType}" not in canonical taxonomy: ${ATLAS_FACT_TYPES.join(', ')}`,
    );
  }

  await addAtlasFact({
    country,
    segment: str(formData, 'segment'),
    entitySlug: str(formData, 'entitySlug'),
    relatedEntitySlug: str(formData, 'relatedEntitySlug'),
    factType: factType as AtlasFactType,
    description,
    sourceProbeId: probeId,
    authoredBy: 'operator',
    createdByUserId: user.id,
  });

  if (probeId) revalidatePath(`/market-probes/${probeId}`);
  revalidatePath(`/market-atlas/${country.toUpperCase()}`);
}

/**
 * Run the strategy-adaptation agent on a probe. Reads current plan +
 * recent metrics + rejection history; emits 0-3 proposals into
 * market_probe_strategy_proposals (status='proposed') for operator
 * review on the probe detail page.
 *
 * Cheap to re-run (single Sonnet call); operators can ask the agent
 * "what should I change?" anytime.
 */
export async function generateStrategyProposalsAction(
  formData: FormData,
): Promise<void> {
  await requireCompany();
  const probeId = str(formData, 'probeId');
  if (!probeId) throw new Error('probeId required');

  const probe = await getProbe(probeId);
  if (!probe) throw new Error('probe not found');

  const targets = await listTargetsForProbe(probeId);
  const rejectionHistory = await listRejectionHistory(probeId);

  // Aggregate metrics from targets. Phase 2C reads from
  // market_probe_targets directly; Phase 2F will integrate touchpoint
  // events for sub-day freshness.
  const metrics = aggregateProbeMetrics(targets);

  const proposals = await proposeProbeStrategyAdjustments({
    marketName: probe.marketName,
    country: probe.country,
    productThesis: probe.productThesis,
    status: probe.status,
    currentPlan: {
      hypothesis: probe.planJson?.hypothesis,
      segments: probe.planJson?.segments,
      outreachAngle: probe.planJson?.outreachAngle,
      successCriteria: probe.planJson?.successCriteria,
    },
    metrics,
    rejectionHistory: rejectionHistory.map((r) => ({
      proposalType: r.proposalType,
      rationale: r.rationale,
      feedback: r.feedback,
      rejectedAt: r.rejectedAt.toISOString(),
    })),
  });

  for (const p of proposals) {
    await insertStrategyProposal({
      probeId,
      proposalType: p.proposalType,
      rationale: p.rationale,
      payload: p.payload,
      evidence: { metricsSnapshot: metrics },
    });
  }

  revalidatePath(`/market-probes/${probeId}`);
}

export async function approveStrategyProposalAction(
  formData: FormData,
): Promise<void> {
  const { user } = await requireCompany();
  const proposalId = str(formData, 'proposalId');
  const probeId = str(formData, 'probeId');
  if (!proposalId || !probeId) throw new Error('proposalId + probeId required');

  await approveStrategyProposal({
    proposalId,
    reviewedByUserId: user.id,
  });
  revalidatePath(`/market-probes/${probeId}`);
}

export async function rejectStrategyProposalAction(
  formData: FormData,
): Promise<void> {
  const { user } = await requireCompany();
  const proposalId = str(formData, 'proposalId');
  const probeId = str(formData, 'probeId');
  const feedback = str(formData, 'feedback') ?? '';
  if (!proposalId || !probeId) throw new Error('proposalId + probeId required');

  await rejectStrategyProposal({
    proposalId,
    reviewedByUserId: user.id,
    feedback,
  });
  revalidatePath(`/market-probes/${probeId}`);
}

/**
 * Roll up probe.target rows into the metric snapshot the strategy
 * agent reads. Per-segment + per-fit-tier breakdown lets the agent
 * propose targeted shifts ("Hotel segment: 8 sent, 0 replies; Marine:
 * 4 sent, 2 routing replies. Pivot.").
 */
function aggregateProbeMetrics(
  targets: Awaited<ReturnType<typeof listTargetsForProbe>>,
): ProbeMetricsSnapshot {
  const segmentBreakdown: Record<
    string,
    { sent: number; replied: number; positiveReplies: number }
  > = {};
  const tierBreakdown: Record<
    string,
    { sent: number; replied: number; positiveReplies: number }
  > = {};
  let sentCount = 0;
  let repliedCount = 0;
  let bouncedCount = 0;
  let unsubscribedCount = 0;
  let positiveReplies = 0;

  for (const t of targets) {
    const isSent = t.sendStatus === 'sent' || t.sendStatus === 'queued';
    const isBounced = t.sendStatus === 'bounced';
    const replied = t.replyStatus && t.replyStatus !== 'none';
    const positive =
      t.replyStatus === 'positive' || t.replyStatus === 'routing';
    const unsubscribed = t.replyStatus === 'unsubscribe';

    if (isSent) sentCount += 1;
    if (isBounced) bouncedCount += 1;
    if (replied) repliedCount += 1;
    if (positive) positiveReplies += 1;
    if (unsubscribed) unsubscribedCount += 1;

    const seg = t.segment ?? '(unsegmented)';
    segmentBreakdown[seg] ??= { sent: 0, replied: 0, positiveReplies: 0 };
    if (isSent) segmentBreakdown[seg]!.sent += 1;
    if (replied) segmentBreakdown[seg]!.replied += 1;
    if (positive) segmentBreakdown[seg]!.positiveReplies += 1;

    const tier = t.fitTier ?? 'C';
    tierBreakdown[tier] ??= { sent: 0, replied: 0, positiveReplies: 0 };
    if (isSent) tierBreakdown[tier]!.sent += 1;
    if (replied) tierBreakdown[tier]!.replied += 1;
    if (positive) tierBreakdown[tier]!.positiveReplies += 1;
  }

  return {
    asOf: new Date().toISOString(),
    targetCount: targets.length,
    sentCount,
    repliedCount,
    bouncedCount,
    unsubscribedCount,
    positiveReplies,
    segmentBreakdown,
    tierBreakdown,
  };
}

// ────────────────────────────────────────────────────────────────
// Phase 2D — discipline layer
// ────────────────────────────────────────────────────────────────

/**
 * Operator adds a hypothesis manually (in addition to the 3-7 the
 * plan-gen agent emits at probe creation).
 */
export async function addHypothesisAction(
  formData: FormData,
): Promise<void> {
  const { user } = await requireCompany();
  const probeId = str(formData, 'probeId');
  const hypothesisType = str(formData, 'hypothesisType');
  const statement = str(formData, 'statement');
  if (!probeId || !hypothesisType || !statement) {
    throw new Error('probeId + hypothesisType + statement required');
  }
  await insertHypothesis({
    probeId,
    hypothesisType: hypothesisType as HypothesisType,
    statement,
    confidenceStart: Number(str(formData, 'confidenceStart') ?? '0.5'),
    testMethod: str(formData, 'testMethod'),
    authoredBy: 'operator',
    createdByUserId: user.id,
  });
  revalidatePath(`/market-probes/${probeId}`);
}

export async function resolveHypothesisAction(
  formData: FormData,
): Promise<void> {
  await requireCompany();
  const probeId = str(formData, 'probeId');
  const hypothesisId = str(formData, 'hypothesisId');
  const status = str(formData, 'status');
  const result = str(formData, 'result') ?? '';
  if (!probeId || !hypothesisId || !status) {
    throw new Error('probeId + hypothesisId + status required');
  }
  await resolveHypothesis({
    hypothesisId,
    status: status as HypothesisStatus,
    result,
  });
  revalidatePath(`/market-probes/${probeId}`);
}

export async function advanceLadderAction(
  formData: FormData,
): Promise<void> {
  await requireCompany();
  const probeId = str(formData, 'probeId');
  const force = str(formData, 'force') === 'true';
  if (!probeId) throw new Error('probeId required');
  await advanceProbeLadder({
    probeId,
    authoredBy: 'operator',
    force,
  });
  revalidatePath(`/market-probes/${probeId}`);
}

export async function setTargetJustificationAction(
  formData: FormData,
): Promise<void> {
  await requireCompany();
  const targetId = str(formData, 'targetId');
  const probeId = str(formData, 'probeId');
  if (!targetId || !probeId) throw new Error('targetId + probeId required');
  // Optional supportingSignals stored as JSON in a hidden field.
  let supportingSignals:
    | Array<{ source: string; label: string; url?: string }>
    | undefined;
  const raw = str(formData, 'supportingSignals');
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) supportingSignals = parsed;
    } catch {
      /* ignore malformed; operator can re-edit */
    }
  }
  await setTargetJustification({
    targetId,
    whyThisCompany: str(formData, 'whyThisCompany'),
    whyThisPerson: str(formData, 'whyThisPerson'),
    whyNow: str(formData, 'whyNow'),
    safestFirstAsk: str(formData, 'safestFirstAsk'),
    ...(supportingSignals !== undefined ? { supportingSignals } : {}),
  });
  revalidatePath(`/market-probes/${probeId}`);
}

export async function markTargetResearchOnlyAction(
  formData: FormData,
): Promise<void> {
  await requireCompany();
  const targetId = str(formData, 'targetId');
  const probeId = str(formData, 'probeId');
  if (!targetId || !probeId) throw new Error('targetId + probeId required');
  await setTargetResearchOnly(targetId);
  revalidatePath(`/market-probes/${probeId}`);
}

// ────────────────────────────────────────────────────────────────
// Phase 2E — measurement layer
// ────────────────────────────────────────────────────────────────

/** Operator sets per-segment estimated total for the coverage map. */
export async function upsertSegmentAction(formData: FormData): Promise<void> {
  await requireCompany();
  const probeId = str(formData, 'probeId');
  const segmentName = str(formData, 'segmentName');
  if (!probeId || !segmentName) {
    throw new Error('probeId + segmentName required');
  }
  await upsertSegment({
    probeId,
    segmentName,
    estimatedTotal: int(formData, 'estimatedTotal'),
    notes: str(formData, 'notes'),
  });
  revalidatePath(`/market-probes/${probeId}`);
}

/** Operator (or agent) toggles per-target signal booleans. */
export async function setTargetSignalsAction(
  formData: FormData,
): Promise<void> {
  await requireCompany();
  const probeId = str(formData, 'probeId');
  const targetId = str(formData, 'targetId');
  if (!probeId || !targetId) throw new Error('probeId + targetId required');
  // Signal updates ride in as a JSON blob keyed signal → bool. Form
  // can build this server-side by reading checkbox state per signal.
  const raw = str(formData, 'signals');
  if (!raw) return;
  let signals: Record<string, boolean> = {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      signals = Object.fromEntries(
        Object.entries(parsed)
          .filter(([, v]) => typeof v === 'boolean')
          .map(([k, v]) => [k, v as boolean]),
      );
    }
  } catch {
    return;
  }
  await setTargetSignals({ targetId, signals });
  revalidatePath(`/market-probes/${probeId}`);
}

/** One-click feedback shortcut on a probe target. Phase 2E writes
 *  the feedback_events row; Phase 2F wires side effects (create_lead
 *  → propose_create_lead, suppress → entity_dispositions, etc.). */
export async function recordTargetFeedbackAction(
  formData: FormData,
): Promise<void> {
  const { user } = await requireCompany();
  const probeId = str(formData, 'probeId');
  const targetId = str(formData, 'targetId');
  const label = str(formData, 'label') as ProbeFeedbackLabel | null;
  if (!probeId || !targetId || !label) {
    throw new Error('probeId + targetId + label required');
  }
  await recordFeedbackShortcut({
    probeId,
    targetId,
    label,
    userId: user.id,
    ...(str(formData, 'note') ? { note: str(formData, 'note')! } : {}),
  });
  revalidatePath(`/market-probes/${probeId}`);
}

// ────────────────────────────────────────────────────────────────
// Phase 2F — synthesis layer
// ────────────────────────────────────────────────────────────────

/**
 * Generate the end-of-probe Learning Report. Sonnet pass over
 * scorecard + atlas + hypotheses + signals + feedback + rejected
 * strategy proposals → structured synthesis. Stored as a row so
 * the operator can re-read + the playbook generator can read the
 * report's nominations.
 *
 * Cheap to re-run; operator can trigger anytime, especially before
 * marking the probe completed.
 */
export async function generateLearningReportAction(
  formData: FormData,
): Promise<void> {
  await requireCompany();
  const probeId = str(formData, 'probeId');
  if (!probeId) throw new Error('probeId required');

  const probe = await getProbe(probeId);
  if (!probe) throw new Error('probe not found');

  const [scorecard, hypotheses, segments, atlasFacts, feedback, rejected] =
    await Promise.all([
      computeProbeScorecard(probeId),
      listHypothesesForProbe(probeId),
      listSegments(probeId),
      listAtlasFactsForProbe(probeId),
      listProbeFeedbackShortcuts(probeId),
      listStrategyProposals(probeId, { status: 'rejected' }),
    ]);
  if (!scorecard) {
    throw new Error('scorecard unavailable — probe has no targets yet');
  }

  const durationMs = Date.now() - new Date(probe.createdAt).getTime();
  const durationDays = Math.max(1, Math.round(durationMs / 86_400_000));

  const result = await generateLearningReport({
    probeName: probe.marketName,
    country: probe.country,
    productThesis: probe.productThesis,
    ladderStage: probe.ladderStage,
    durationDays,
    scorecard: {
      targetsTotal: scorecard.targetsTotal,
      sentCount: scorecard.sentCount,
      repliedCount: scorecard.repliedCount,
      positiveReplies: scorecard.positiveReplies,
      bouncedCount: scorecard.bouncedCount,
      replyRate: scorecard.replyRate,
      routingRate: scorecard.routingRate,
      qualifiedInterestRate: scorecard.qualifiedInterestRate,
      bounceRate: scorecard.bounceRate,
      atlasFactsCount: scorecard.atlasFactsCount,
      atlasNegativeRulesCount: scorecard.atlasNegativeRulesCount,
      hypothesesActive: scorecard.hypothesesActive,
      hypothesesConfirmed: scorecard.hypothesesConfirmed,
      hypothesesFalsified: scorecard.hypothesesFalsified,
      overallLearning: scorecard.scores.overallLearning,
    },
    hypotheses: hypotheses.map((h) => ({
      hypothesisType: h.hypothesisType,
      statement: h.statement,
      status: h.status,
      confidenceStart: Number(h.confidenceStart),
      confidenceCurrent: Number(h.confidenceCurrent),
      result: h.result,
    })),
    segments: segments.map((s) => ({
      name: s.segmentName,
      estimatedTotal: s.estimatedTotal,
      identified: s.identifiedCount,
      contacted: s.contactedCount,
      replied: s.repliedCount,
    })),
    topSignals: scorecard.topSignals.map((s) => ({
      signal: s.signal,
      withSent: s.withSignal.sent,
      withReplied: s.withSignal.replied,
      withoutSent: s.withoutSignal.sent,
      withoutReplied: s.withoutSignal.replied,
      replyDelta: s.replyDelta,
    })),
    atlasFacts: atlasFacts.map((f) => ({
      factType: f.factType,
      description: f.description,
      ruleText: f.ruleText,
    })),
    feedbackShortcuts: feedback.map((f) => ({
      label: String(
        (f.payload as Record<string, unknown>)?.['label'] ?? '(unknown)',
      ),
      sentiment: f.sentiment ?? 'neutral',
      payload: (f.payload as Record<string, unknown>) ?? {},
    })),
    rejectedStrategyProposals: rejected.map((p) => ({
      proposalType: p.proposalType,
      rationale: p.rationale,
      feedback: p.reviewerFeedback,
    })),
  });

  await insertLearningReport({
    probeId,
    summary: result.summary,
    payload: result.payload,
    scorecardSnapshot: scorecard as unknown as Record<string, unknown>,
    generatedByModel: 'claude-sonnet',
  });

  revalidatePath(`/market-probes/${probeId}`);
}

/**
 * Save the probe's nominations (from latest learning report) as a
 * new playbook. Operator picks a name + applicableCountries and
 * confirms the report's recommended segments / titles / first-touch.
 */
export async function savePlaybookFromProbeAction(
  formData: FormData,
): Promise<void> {
  const { user } = await requireCompany();
  const probeId = str(formData, 'probeId');
  const name = str(formData, 'name');
  if (!probeId || !name) throw new Error('probeId + name required');

  const probe = await getProbe(probeId);
  if (!probe) throw new Error('probe not found');

  const scorecard = await computeProbeScorecard(probeId);
  if (!scorecard) throw new Error('scorecard unavailable');

  // Read report nominations if present; operator can override via
  // form fields.
  let nominated: LearningReportPayload['playbookUpdates'] = {};
  const recent = await getLatestLearningReport(probeId);
  if (recent) {
    nominated = recent.payloadJson?.playbookUpdates ?? {};
  }

  const applicableCountries = csv(formData, 'applicableCountries').length > 0
    ? csv(formData, 'applicableCountries').map((c) => c.toUpperCase())
    : (nominated?.applicableCountries ?? (probe.country ? [probe.country.toUpperCase()] : []));

  const playbook = await savePlaybookFromProbe({
    probeId,
    name,
    description: str(formData, 'description'),
    parentPlaybookId: str(formData, 'parentPlaybookId'),
    applicableCountries,
    benchmarks: {
      replyRate: scorecard.replyRate,
      routingRate: scorecard.routingRate,
      qualifiedInterestRate: scorecard.qualifiedInterestRate,
      bounceRate: scorecard.bounceRate,
    },
    recommendedSegments:
      csv(formData, 'recommendedSegments').length > 0
        ? csv(formData, 'recommendedSegments')
        : nominated?.recommendedSegments,
    avoidedSegments:
      csv(formData, 'avoidedSegments').length > 0
        ? csv(formData, 'avoidedSegments')
        : nominated?.avoidedSegments,
    bestContactTitles:
      csv(formData, 'bestContactTitles').length > 0
        ? csv(formData, 'bestContactTitles')
        : nominated?.bestContactTitles,
    bestFirstTouchAngle:
      str(formData, 'bestFirstTouchAngle') ?? nominated?.bestFirstTouchAngle,
    createdByUserId: user.id,
  });

  revalidatePath(`/market-probes/${probeId}`);
  revalidatePath('/market-playbooks');
  revalidatePath(`/market-playbooks/${playbook.id}`);
}

export async function setPlaybookStatusAction(
  formData: FormData,
): Promise<void> {
  await requireCompany();
  const playbookId = str(formData, 'playbookId');
  const status = str(formData, 'status') as
    | 'draft'
    | 'active'
    | 'deprecated'
    | null;
  if (!playbookId || !status) throw new Error('playbookId + status required');
  await setPlaybookStatus(playbookId, status);
  revalidatePath('/market-playbooks');
  revalidatePath(`/market-playbooks/${playbookId}`);
}

// ────────────────────────────────────────────────────────────────
// Phase 2G — safety net
// ────────────────────────────────────────────────────────────────

/** Set probe.mode (experiment / relationship). Phase 2H autopilot
 *  refuses to fire for relationship probes regardless of probe.tier. */
export async function setProbeModeAction(formData: FormData): Promise<void> {
  await requireCompany();
  const probeId = str(formData, 'probeId');
  const mode = str(formData, 'mode');
  if (!probeId || !mode) throw new Error('probeId + mode required');
  if (mode !== 'experiment' && mode !== 'relationship') {
    throw new Error(`invalid mode: ${mode}`);
  }
  await db
    .update(marketProbes)
    .set({ mode, updatedAt: new Date() })
    .where(eq(marketProbes.id, probeId));
  revalidatePath(`/market-probes/${probeId}`);
}

/** Operator-set kill criteria thresholds. */
export async function setProbeKillCriteriaAction(
  formData: FormData,
): Promise<void> {
  await requireCompany();
  const probeId = str(formData, 'probeId');
  if (!probeId) throw new Error('probeId required');
  const fields: Record<string, unknown> = { updatedAt: new Date() };
  const bounce = str(formData, 'maxBounceRatePct');
  if (bounce) fields.maxBounceRatePct = String(Number(bounce));
  const complaint = str(formData, 'maxComplaintRatePct');
  if (complaint) fields.maxComplaintRatePct = String(Number(complaint));
  const segPause = int(formData, 'maxNoReplyBeforeSegmentPause');
  if (segPause != null) fields.maxNoReplyBeforeSegmentPause = segPause;
  const totalPause = int(formData, 'maxTotalNoSignalBeforeProbePause');
  if (totalPause != null) fields.maxTotalNoSignalBeforeProbePause = totalPause;
  await db
    .update(marketProbes)
    .set(fields)
    .where(eq(marketProbes.id, probeId));
  revalidatePath(`/market-probes/${probeId}`);
}

/** Toggle scout_protection on a known_entities row. Operator opts in
 *  per entity from the entity profile or via the probe target row's
 *  inline action. */
export async function toggleScoutProtectionAction(
  formData: FormData,
): Promise<void> {
  await requireCompany();
  const slug = str(formData, 'slug');
  const value = str(formData, 'value');
  if (!slug || !value) throw new Error('slug + value required');
  const protected_ = value === 'true';
  await db
    .update(knownEntities)
    .set({ scoutProtection: protected_, updatedAt: new Date() })
    .where(eq(knownEntities.slug, slug));
  // Revalidate probe routes broadly — any probe could surface this
  // entity. Cheap; revalidatePath without a specific id revalidates
  // the parent layout segment.
  revalidatePath('/market-probes');
  revalidatePath(`/entities/${encodeURIComponent(slug)}`);
}

// ────────────────────────────────────────────────────────────────
// Phase 2H — autopilot
// ────────────────────────────────────────────────────────────────

/**
 * Trigger the autopilot send batch. All gates (mode, tier, kill
 * criteria, scout protection, daily/total caps) are enforced inside
 * `autopilotSendBatch` — the action just kicks it off + revalidates.
 */
export async function autopilotSendBatchAction(
  formData: FormData,
): Promise<void> {
  await requireCompany();
  const probeId = str(formData, 'probeId');
  if (!probeId) throw new Error('probeId required');
  const result = await autopilotSendBatch({ probeId });
  // Revalidate even on refusal — operator sees the reason via probe
  // state (paused) or via the next page load. Phase 2I adds a
  // toast/notification surface for batch results.
  revalidatePath(`/market-probes/${probeId}`);
  if (!result.ok && result.killCriteriaTriggered) {
    // Already paused inside the helper — nothing more to do.
  }
}

/** Operator can also flip probe.tier 0 → 1 to enable autopilot. */
export async function setProbeTierAction(formData: FormData): Promise<void> {
  await requireCompany();
  const probeId = str(formData, 'probeId');
  const tierRaw = str(formData, 'tier');
  if (!probeId || tierRaw == null) throw new Error('probeId + tier required');
  const tier = Number.parseInt(tierRaw, 10);
  if (!Number.isFinite(tier) || tier < 0 || tier > 3) {
    throw new Error(`invalid tier: ${tierRaw}`);
  }
  await db
    .update(marketProbes)
    .set({ tier, updatedAt: new Date() })
    .where(eq(marketProbes.id, probeId));
  revalidatePath(`/market-probes/${probeId}`);
}

// ────────────────────────────────────────────────────────────────
// Phase 2I.4 — message variant testing
// ────────────────────────────────────────────────────────────────

export async function createVariantAction(
  formData: FormData,
): Promise<void> {
  const { user } = await requireCompany();
  const probeId = str(formData, 'probeId');
  const variantName = str(formData, 'variantName');
  if (!probeId || !variantName) {
    throw new Error('probeId + variantName required');
  }
  await createVariant({
    probeId,
    variantName,
    subjectTemplate: str(formData, 'subjectTemplate'),
    bodyTemplate: str(formData, 'bodyTemplate'),
    angle: str(formData, 'angle'),
    weight: Number(str(formData, 'weight') ?? '1'),
    notes: str(formData, 'notes'),
    createdByUserId: user.id,
  });
  revalidatePath(`/market-probes/${probeId}`);
}

export async function setVariantStatusAction(
  formData: FormData,
): Promise<void> {
  await requireCompany();
  const variantId = str(formData, 'variantId');
  const probeId = str(formData, 'probeId');
  const status = str(formData, 'status') as VariantStatus | null;
  if (!variantId || !probeId || !status) {
    throw new Error('variantId + probeId + status required');
  }
  await setVariantStatus({ variantId, status });
  revalidatePath(`/market-probes/${probeId}`);
}

export async function setTaskSkippedAction(formData: FormData): Promise<void> {
  await requireCompany();
  const probeId = str(formData, 'probeId');
  const taskId = str(formData, 'taskId');
  if (!probeId || !taskId) throw new Error('probeId + taskId required');
  await markProbeTaskStatus(
    probeId,
    taskId,
    'skipped',
    'Operator skipped this step.',
  );
  revalidatePath(`/market-probes/${probeId}`);
}
