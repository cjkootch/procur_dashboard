import 'server-only';
import { desc, eq } from 'drizzle-orm';
import {
  db,
  marketProbeHypotheses,
  marketProbes,
  type HypothesisEvidence,
  type HypothesisStatus,
  type HypothesisType,
  type LadderStage,
  type MarketProbeHypothesis,
  type NewMarketProbeHypothesis,
  marketProbeTargets,
  LADDER_STAGES,
  HYPOTHESIS_TYPES,
  HYPOTHESIS_STATUSES,
  TARGET_JUSTIFICATION_STATES,
} from '@procur/db';
import { createId } from '@procur/ai';

// Re-export taxonomies + types so apps/app can import them via
// @procur/catalog (the canonical surface) without reaching into
// @procur/db. Existing callers of these constants (e.g.
// /market-probes/[id]/page.tsx) import via @procur/catalog.
export {
  HYPOTHESIS_TYPES,
  HYPOTHESIS_STATUSES,
  LADDER_STAGES,
  TARGET_JUSTIFICATION_STATES,
};
export type {
  HypothesisType,
  HypothesisStatus,
  LadderStage,
  HypothesisEvidence,
  MarketProbeHypothesis,
};

/**
 * Hypothesis lifecycle for Market Probes. The plan-gen agent emits
 * 3-7 at probe creation; operator edits + adds + resolves. Strategy
 * proposals reference hypotheses (Phase 2E will add the link); the
 * Learning Report (Phase 2F) diffs confidence_start vs confidence_current
 * + result.
 */

export interface InsertHypothesisInput {
  probeId: string;
  hypothesisType: HypothesisType | string;
  statement: string;
  confidenceStart?: number;
  testMethod?: string | null;
  authoredBy?: 'agent' | 'operator';
  createdByUserId?: string | null;
}

export async function insertHypothesis(
  input: InsertHypothesisInput,
): Promise<MarketProbeHypothesis> {
  const c = input.confidenceStart ?? 0.5;
  const row: NewMarketProbeHypothesis = {
    id: createId(),
    probeId: input.probeId,
    hypothesisType: input.hypothesisType,
    statement: input.statement,
    confidenceStart: String(c),
    confidenceCurrent: String(c),
    testMethod: input.testMethod ?? null,
    status: 'active',
    evidenceJson: [],
    authoredBy: input.authoredBy ?? 'agent',
    createdByUserId: input.createdByUserId ?? null,
  };
  const [created] = await db
    .insert(marketProbeHypotheses)
    .values(row)
    .returning();
  if (!created) throw new Error('insertHypothesis: no row returned');
  return created;
}

export async function bulkInsertHypotheses(
  probeId: string,
  hypotheses: Array<{
    hypothesisType: HypothesisType | string;
    statement: string;
    confidenceStart?: number;
    testMethod?: string | null;
  }>,
): Promise<number> {
  if (hypotheses.length === 0) return 0;
  const rows: NewMarketProbeHypothesis[] = hypotheses.map((h) => {
    const c = h.confidenceStart ?? 0.5;
    return {
      id: createId(),
      probeId,
      hypothesisType: h.hypothesisType,
      statement: h.statement,
      confidenceStart: String(c),
      confidenceCurrent: String(c),
      testMethod: h.testMethod ?? null,
      status: 'active',
      evidenceJson: [],
      authoredBy: 'agent',
    };
  });
  const inserted = await db
    .insert(marketProbeHypotheses)
    .values(rows)
    .returning({ id: marketProbeHypotheses.id });
  return inserted.length;
}

export async function listHypothesesForProbe(
  probeId: string,
): Promise<MarketProbeHypothesis[]> {
  return await db
    .select()
    .from(marketProbeHypotheses)
    .where(eq(marketProbeHypotheses.probeId, probeId))
    .orderBy(desc(marketProbeHypotheses.createdAt));
}

/**
 * Update confidence + append an evidence entry. Used by the agent
 * (rolling updates as signal lands) and the operator (manual
 * "I think this is wrong now").
 */
export async function appendHypothesisEvidence(input: {
  hypothesisId: string;
  newConfidence: number;
  source: 'agent' | 'operator';
  note: string;
  evidence?: Record<string, unknown>;
}): Promise<MarketProbeHypothesis | null> {
  const [current] = await db
    .select()
    .from(marketProbeHypotheses)
    .where(eq(marketProbeHypotheses.id, input.hypothesisId))
    .limit(1);
  if (!current) return null;
  const newEntry: HypothesisEvidence = {
    at: new Date().toISOString(),
    source: input.source,
    confidence: input.newConfidence,
    note: input.note,
    ...(input.evidence ? { evidence: input.evidence } : {}),
  };
  const trail = [...(current.evidenceJson ?? []), newEntry];
  const [row] = await db
    .update(marketProbeHypotheses)
    .set({
      confidenceCurrent: String(input.newConfidence),
      evidenceJson: trail,
      updatedAt: new Date(),
    })
    .where(eq(marketProbeHypotheses.id, input.hypothesisId))
    .returning();
  return row ?? null;
}

export async function resolveHypothesis(input: {
  hypothesisId: string;
  status: HypothesisStatus;
  result: string;
}): Promise<void> {
  await db
    .update(marketProbeHypotheses)
    .set({
      status: input.status,
      result: input.result,
      updatedAt: new Date(),
    })
    .where(eq(marketProbeHypotheses.id, input.hypothesisId));
}

// ──────────────────────────────────────────────────────────────────
// Ladder stage transitions
// ──────────────────────────────────────────────────────────────────

export interface AdvanceLadderResult {
  ok: boolean;
  fromStage?: LadderStage;
  toStage?: LadderStage;
  reason?: string;
}

/**
 * Advance probe to the next ladder stage. Hard discipline rule: we
 * gate advances on observable evidence from the previous stage.
 *
 *   market_structure → routing
 *     requires: at least 1 target with justification (justified
 *     state) OR an explicit operator-set atlas fact for the country.
 *
 *   routing → pain_discovery
 *     requires: at least 1 reply (replyStatus IN positive | routing).
 *
 *   pain_discovery → commercial_qualification
 *     requires: at least 1 positive reply.
 *
 *   commercial_qualification → deal_room_conversion
 *     requires: at least 1 qualified disposition on a target.
 *
 * Operator can FORCE-advance with `force=true` (Phase 2D; Phase 2E
 * adds an audit trail). The agent cannot force.
 */
export async function advanceProbeLadder(input: {
  probeId: string;
  authoredBy: 'agent' | 'operator';
  force?: boolean;
}): Promise<AdvanceLadderResult> {
  const [probe] = await db
    .select()
    .from(marketProbes)
    .where(eq(marketProbes.id, input.probeId))
    .limit(1);
  if (!probe) return { ok: false, reason: 'probe not found' };

  const fromStage = probe.ladderStage as LadderStage;
  const fromIdx = LADDER_STAGES.indexOf(fromStage);
  if (fromIdx === -1) {
    return { ok: false, reason: `unknown stage: ${fromStage}` };
  }
  const toStage = LADDER_STAGES[fromIdx + 1];
  if (!toStage) {
    return {
      ok: false,
      fromStage,
      reason: 'already at final stage (deal_room_conversion)',
    };
  }

  // Compute the evidence-based blocker for the current stage. Agent
  // calls always honor the blocker (agent cannot force). Operator
  // calls honor it unless `force=true`. Earlier shape gated the
  // entire block on `!input.force`, which made the operator-with-
  // force path skip the targets read AND the `!input.force` check
  // inside redundant — dead code that read like override-capable
  // logic but wasn't.
  const targets = await db
    .select({
      sendStatus: marketProbeTargets.sendStatus,
      replyStatus: marketProbeTargets.replyStatus,
      disposition: marketProbeTargets.disposition,
      justificationState: marketProbeTargets.justificationState,
    })
    .from(marketProbeTargets)
    .where(eq(marketProbeTargets.probeId, input.probeId));

  const justifiedCount = targets.filter(
    (t) => t.justificationState === 'justified',
  ).length;
  const repliedCount = targets.filter(
    (t) => t.replyStatus === 'positive' || t.replyStatus === 'routing',
  ).length;
  const positiveCount = targets.filter(
    (t) => t.replyStatus === 'positive',
  ).length;
  const qualifiedCount = targets.filter(
    (t) => t.disposition === 'qualified',
  ).length;

  let blocker: string | null = null;
  switch (fromStage) {
    case 'market_structure':
      if (justifiedCount === 0) {
        blocker =
          'no justified targets yet — fill in justification on at least one target before advancing to routing';
      }
      break;
    case 'routing':
      if (repliedCount === 0) {
        blocker =
          'no routing replies yet — wait for at least one positive/routing reply before advancing to pain_discovery';
      }
      break;
    case 'pain_discovery':
      if (positiveCount === 0) {
        blocker =
          'no positive replies yet — wait for at least one positive reply before advancing to commercial_qualification';
      }
      break;
    case 'commercial_qualification':
      if (qualifiedCount === 0) {
        blocker =
          'no targets marked qualified — set a target disposition to qualified before advancing to deal_room_conversion';
      }
      break;
    default:
      break;
  }

  if (blocker) {
    // Agent cannot force; refuse outright.
    if (input.authoredBy === 'agent') {
      return { ok: false, fromStage, toStage, reason: blocker };
    }
    // Operator can force; otherwise honor the blocker.
    if (input.authoredBy === 'operator' && !input.force) {
      return { ok: false, fromStage, toStage, reason: blocker };
    }
    // Fall through — operator-forced advance writes through with no
    // additional check.
  }

  await db
    .update(marketProbes)
    .set({ ladderStage: toStage, updatedAt: new Date() })
    .where(eq(marketProbes.id, input.probeId));

  return { ok: true, fromStage, toStage };
}

// ──────────────────────────────────────────────────────────────────
// Target justification gate
// ──────────────────────────────────────────────────────────────────

export interface SetTargetJustificationInput {
  targetId: string;
  whyThisCompany?: string | null;
  whyThisPerson?: string | null;
  whyNow?: string | null;
  supportingSignals?: Array<{ source: string; label: string; url?: string }>;
  safestFirstAsk?: string | null;
}

/**
 * Update justification fields. Auto-promotes justification_state:
 *   - All four narrative fields populated → 'justified'
 *   - Some populated → 'pending' (work in progress)
 *   - None + operator explicit "research_only" → see
 *     setTargetResearchOnly below
 *
 * Phase 2H autopilot reads `justificationState='justified'` to decide
 * which targets enter the daily-send queue.
 */
export async function setTargetJustification(
  input: SetTargetJustificationInput,
): Promise<void> {
  const fields: Record<string, unknown> = { updatedAt: new Date() };
  if (input.whyThisCompany !== undefined) {
    fields.whyThisCompany = input.whyThisCompany;
  }
  if (input.whyThisPerson !== undefined) {
    fields.whyThisPerson = input.whyThisPerson;
  }
  if (input.whyNow !== undefined) fields.whyNow = input.whyNow;
  if (input.safestFirstAsk !== undefined) {
    fields.safestFirstAsk = input.safestFirstAsk;
  }
  if (input.supportingSignals !== undefined) {
    fields.supportingSignals = input.supportingSignals;
  }

  // Re-read row to compute justification state — needs the merged
  // values, not just the patch.
  const [target] = await db
    .select()
    .from(marketProbeTargets)
    .where(eq(marketProbeTargets.id, input.targetId))
    .limit(1);
  if (!target) return;
  const merged = {
    whyThisCompany:
      input.whyThisCompany !== undefined
        ? input.whyThisCompany
        : target.whyThisCompany,
    whyThisPerson:
      input.whyThisPerson !== undefined
        ? input.whyThisPerson
        : target.whyThisPerson,
    whyNow: input.whyNow !== undefined ? input.whyNow : target.whyNow,
    safestFirstAsk:
      input.safestFirstAsk !== undefined
        ? input.safestFirstAsk
        : target.safestFirstAsk,
  };
  const filledCount = [
    merged.whyThisCompany,
    merged.whyThisPerson,
    merged.whyNow,
    merged.safestFirstAsk,
  ].filter((v) => v && v.trim().length > 0).length;
  // All four narrative fields = justified. Anything less stays pending
  // (operator can mark research_only explicitly via a separate path).
  fields.justificationState = filledCount >= 4 ? 'justified' : 'pending';

  await db
    .update(marketProbeTargets)
    .set(fields)
    .where(eq(marketProbeTargets.id, input.targetId));
}

/** Operator-initiated demote to research_only (e.g. "lookalike landed
 *  but I don't want to outreach this one"). */
export async function setTargetResearchOnly(targetId: string): Promise<void> {
  await db
    .update(marketProbeTargets)
    .set({ justificationState: 'research_only', updatedAt: new Date() })
    .where(eq(marketProbeTargets.id, targetId));
}

/**
 * Aggregate view used by the probe detail UI + Phase 2H autopilot:
 *   { pending, research_only, justified } counts per probe.
 */
export async function countTargetsByJustification(
  probeId: string,
): Promise<{ pending: number; research_only: number; justified: number }> {
  const targets = await db
    .select({ state: marketProbeTargets.justificationState })
    .from(marketProbeTargets)
    .where(eq(marketProbeTargets.probeId, probeId));
  const counts = { pending: 0, research_only: 0, justified: 0 };
  for (const t of targets) {
    if (t.state === 'justified') counts.justified += 1;
    else if (t.state === 'research_only') counts.research_only += 1;
    else counts.pending += 1;
  }
  return counts;
}
