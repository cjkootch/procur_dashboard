'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireCompany } from '@procur/auth';
import { createId } from '@procur/ai';
import {
  createProbe,
  getProbe,
  markProbeTaskStatus,
  setProbePlan,
  setProbeStatus,
  upsertProbeTargets,
  recommendCommunicationTargets,
} from '@procur/catalog';
import { generateProbePlan } from '@procur/ai';

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

  const plan = await generateProbePlan({
    marketName: probe.marketName,
    country: probe.country,
    productThesis: probe.productThesis,
    riskLevel: probe.riskLevel as 'low' | 'medium' | 'high',
    objective: probe.objective,
    allowedChannels: probe.allowedChannels,
    dailySendLimit: probe.dailySendLimit,
    totalSendLimit: probe.totalSendLimit,
  });

  await setProbePlan(probeId, plan);
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
