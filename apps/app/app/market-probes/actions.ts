'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireCompany } from '@procur/auth';
import { createId } from '@procur/ai';
import {
  addApolloLookalikesToProbe,
  addAtlasFact,
  addThesisDrivenApolloOrgsToProbe,
  advanceProbeLadder,
  approveStrategyProposal,
  bulkInsertHypotheses,
  createProbe,
  findDecisionMakersForTarget,
  getProbe,
  insertHypothesis,
  insertStrategyProposal,
  listAtlasFacts,
  listRejectionHistory,
  listTargetsForProbe,
  markProbeTaskStatus,
  rejectStrategyProposal,
  resolveHypothesis,
  setProbePlan,
  setProbeStatus,
  setTargetJustification,
  setTargetResearchOnly,
  upsertProbeTargets,
  recommendCommunicationTargets,
  type AtlasFactType,
  type HypothesisStatus,
  type HypothesisType,
} from '@procur/catalog';
import {
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

  const candidates = await recommendCommunicationTargets({
    limit: 25,
    filters,
  });

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
    await markProbeTaskStatus(
      probeId,
      'find_contacts',
      'done',
      `${result.candidatesFound} decision-maker candidate${result.candidatesFound === 1 ? '' : 's'} found for ${result.entitySlug}; see entity profile Decision-makers panel.`,
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
