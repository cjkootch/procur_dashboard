import 'server-only';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import {
  conversationSettings,
  db,
  marketProbeTargets,
  marketProbes,
  type MarketProbe,
  type MarketProbeTarget,
  type NewMarketProbe,
  type NewMarketProbeTarget,
  type ProbePlan,
  type ProbeTask,
} from '@procur/db';

/**
 * Read/write helpers for the Market Probes feature. The probe is a
 * bounded autonomous market-prospecting experiment — see migration
 * 0095 for the full design rationale. Phase 1 ships:
 *   - createProbe / listProbes / getProbe — CRUD
 *   - upsertProbeTargets — used by the target-discovery action
 *   - markTaskStatus — agent + operator both flip task status as the
 *     plan's checklist crosses off
 *   - listTargetsForProbe — feeds the dashboard
 *
 * Phase 2 will add: graduateTier, suppressionAdd, autopilotDispatch.
 */

export const PROBE_DEFAULT_TASKS: ProbeTask[] = [
  {
    id: 'generate_plan',
    label: 'Generate market plan',
    status: 'pending',
  },
  {
    id: 'identify_targets',
    label: 'Identify target companies',
    status: 'pending',
  },
  {
    id: 'find_contacts',
    label: 'Find named contacts',
    status: 'pending',
  },
  {
    id: 'draft_first_touch',
    label: 'Draft first-touch emails',
    status: 'pending',
  },
  {
    id: 'send_first_touch',
    label: 'Send approved drafts',
    status: 'pending',
  },
  {
    id: 'monitor_replies',
    label: 'Monitor replies + classify',
    status: 'pending',
  },
  {
    id: 'summarize_findings',
    label: 'Summarize findings + recommend next step',
    status: 'pending',
  },
];

export interface CreateProbeInput {
  id: string;
  marketName: string;
  country?: string | null;
  productThesis: string;
  riskLevel?: 'low' | 'medium' | 'high';
  objective?: string | null;
  allowedChannels?: string[];
  allowedSegments?: string[];
  blockedTerms?: string[];
  blockedEntitySlugs?: string[];
  dailySendLimit?: number;
  totalSendLimit?: number;
  createdBy?: string | null;
}

export async function createProbe(input: CreateProbeInput): Promise<MarketProbe> {
  const row: NewMarketProbe = {
    id: input.id,
    marketName: input.marketName,
    country: input.country ?? null,
    productThesis: input.productThesis,
    riskLevel: input.riskLevel ?? 'low',
    status: 'planning',
    tier: 0,
    objective: input.objective ?? null,
    successCriteriaJson: {},
    allowedChannels: input.allowedChannels ?? ['email'],
    allowedSegments: input.allowedSegments ?? [],
    blockedTerms: input.blockedTerms ?? [],
    blockedEntitySlugs: input.blockedEntitySlugs ?? [],
    dailySendLimit: input.dailySendLimit ?? 10,
    totalSendLimit: input.totalSendLimit ?? 50,
    maxFollowupsPerContact: 1,
    // Seed the plan with the default task checklist; the
    // plan-generation pass fills in hypothesis/segments/etc. later
    // and may add probe-specific tasks.
    planJson: { tasks: PROBE_DEFAULT_TASKS },
    createdBy: input.createdBy ?? null,
  };
  const [created] = await db.insert(marketProbes).values(row).returning();
  if (!created) throw new Error('createProbe: insert returned no row');
  return created;
}

export async function listProbes(options: {
  status?: MarketProbe['status'];
  limit?: number;
} = {}): Promise<Array<MarketProbe & { targetCount: number; sentCount: number; replyCount: number }>> {
  const limit = options.limit ?? 50;
  const where = options.status ? eq(marketProbes.status, options.status) : undefined;
  const probeRows = await db
    .select()
    .from(marketProbes)
    .where(where)
    .orderBy(desc(marketProbes.createdAt))
    .limit(limit);
  if (probeRows.length === 0) return [];
  // One aggregate query for counts across all probes — cheaper than
  // N round-trips even at small probe counts. GROUP BY probe_id with
  // FILTER for the per-status sums.
  const counts = await db
    .select({
      probeId: marketProbeTargets.probeId,
      targetCount: sql<number>`COUNT(*)::int`,
      sentCount: sql<number>`COUNT(*) FILTER (WHERE ${marketProbeTargets.sendStatus} IN ('sent','queued'))::int`,
      // Exclude 'unsubscribe' from the reply count — operators reading
      // the brief card use this number as a "did anyone engage?" signal,
      // and an unsubscribe is the opposite of engagement. The audit
      // caught the inflated count flipping the brief's "good" signal
      // badge for probes that only got opt-outs.
      replyCount: sql<number>`COUNT(*) FILTER (WHERE ${marketProbeTargets.replyStatus} IS NOT NULL AND ${marketProbeTargets.replyStatus} NOT IN ('none', 'unsubscribe'))::int`,
    })
    .from(marketProbeTargets)
    .groupBy(marketProbeTargets.probeId);
  const countMap = new Map(counts.map((c) => [c.probeId, c]));
  return probeRows.map((p) => {
    const c = countMap.get(p.id);
    return {
      ...p,
      targetCount: c?.targetCount ?? 0,
      sentCount: c?.sentCount ?? 0,
      replyCount: c?.replyCount ?? 0,
    };
  });
}

export async function getProbe(id: string): Promise<MarketProbe | null> {
  const [row] = await db
    .select()
    .from(marketProbes)
    .where(eq(marketProbes.id, id))
    .limit(1);
  return row ?? null;
}

export async function listTargetsForProbe(
  probeId: string,
): Promise<MarketProbeTarget[]> {
  return await db
    .select()
    .from(marketProbeTargets)
    .where(eq(marketProbeTargets.probeId, probeId))
    .orderBy(desc(marketProbeTargets.confidence));
}

/**
 * Insert-or-update a batch of targets discovered for a probe. The
 * (probe_id, entity_slug) unique index handles the dedupe — re-running
 * target discovery on the same probe just refreshes evidence/confidence
 * without resetting send_status (operator state is preserved).
 */
export async function upsertProbeTargets(
  probeId: string,
  targets: Array<{
    id: string;
    entitySlug: string;
    contactId?: string | null;
    segment?: string | null;
    fitTier: 'A' | 'B' | 'C' | 'D';
    confidence: number;
    evidenceJson: Record<string, unknown>;
  }>,
): Promise<number> {
  if (targets.length === 0) return 0;
  const rows: NewMarketProbeTarget[] = targets.map((t) => ({
    id: t.id,
    probeId,
    entitySlug: t.entitySlug,
    contactId: t.contactId ?? null,
    segment: t.segment ?? null,
    fitTier: t.fitTier,
    confidence: String(t.confidence),
    evidenceJson: t.evidenceJson,
    sendStatus: 'pending',
  }));
  // Doing onConflictDoUpdate so re-running target discovery refreshes
  // evidence/confidence without resetting operator-managed columns
  // (sendStatus, replyStatus, disposition).
  const inserted = await db
    .insert(marketProbeTargets)
    .values(rows)
    .onConflictDoUpdate({
      target: [marketProbeTargets.probeId, marketProbeTargets.entitySlug],
      set: {
        fitTier: sql`excluded.fit_tier`,
        confidence: sql`excluded.confidence`,
        evidenceJson: sql`excluded.evidence_json`,
        segment: sql`excluded.segment`,
        contactId: sql`COALESCE(${marketProbeTargets.contactId}, excluded.contact_id)`,
        updatedAt: new Date(),
      },
    })
    .returning({ id: marketProbeTargets.id });
  return inserted.length;
}

/**
 * Mark a probe target's send_status. Used by the operator-approve flow
 * (queued → sent), and Phase 2 will use it for autopilot.
 */
export async function setTargetSendStatus(
  targetId: string,
  status: MarketProbeTarget['sendStatus'],
): Promise<void> {
  await db
    .update(marketProbeTargets)
    .set({ sendStatus: status, lastTouchAt: new Date(), updatedAt: new Date() })
    .where(eq(marketProbeTargets.id, targetId));
}

/**
 * Replace the probe's plan_json wholesale. Used after plan-generation
 * lands a fresh plan from the LLM.
 *
 * Task-state preservation: the prior shape wrote planJson directly,
 * which clobbered operator-edited task statuses on regeneration. An
 * operator who marked identify_targets='done' last week and then
 * regenerated the plan (e.g., after rejecting strategy proposals)
 * watched the task flip back to 'pending' — losing the audit trail
 * and forcing them to re-mark it. Now the merge is: for each task id
 * in the new plan, if that id already exists in the current plan,
 * carry over status / completedAt / result; the new label and
 * incoming order win. New ids land as the new plan dictates; dropped
 * ids are removed. The "generate_plan" task is the exception —
 * regeneration always re-runs it, so its done timestamp updates.
 *
 * Status promotion gate: the probe flips planning → active ONLY when
 * the plan came back from a successful Sonnet pass
 * (generationStatus === 'ok' or absent for back-compat with plans
 * created before the field landed). When the plan is a fallback
 * skeleton (no API key / parse error), status stays at 'planning' —
 * the operator sees the failure banner, retries plan generation, OR
 * explicitly accepts the hollow plan via approveFallbackPlanAction
 * (which clears generationStatus and re-runs setProbePlan).
 *
 * Without this gate, a probe with no hypotheses would transition to
 * active and autopilot could send outreach grounded in nothing.
 */
export async function setProbePlan(
  probeId: string,
  plan: ProbePlan,
): Promise<MarketProbe | null> {
  const isClean =
    plan.generationStatus === undefined || plan.generationStatus === 'ok';
  // Preserve operator-edited task status across regeneration.
  const existing = await getProbe(probeId);
  const existingTasksById = new Map(
    (existing?.planJson?.tasks ?? []).map((t) => [t.id, t]),
  );
  const mergedTasks = (plan.tasks ?? []).map((newT) => {
    if (newT.id === 'generate_plan') {
      // Regeneration always re-completes generate_plan with a fresh
      // timestamp — the act of running setProbePlan IS that task.
      return newT;
    }
    const prior = existingTasksById.get(newT.id);
    if (!prior) return newT;
    return {
      ...newT,
      status: prior.status,
      ...(prior.completedAt ? { completedAt: prior.completedAt } : {}),
      ...(prior.result ? { result: prior.result } : {}),
    };
  });
  const mergedPlan: ProbePlan = { ...plan, tasks: mergedTasks };

  const [row] = await db
    .update(marketProbes)
    .set({
      planJson: mergedPlan,
      ...(isClean ? { status: 'active' as const } : {}),
      updatedAt: new Date(),
    })
    .where(eq(marketProbes.id, probeId))
    .returning();
  return row ?? null;
}

/**
 * Update one task in the probe's plan checklist — agent calls this as
 * it advances ("identify_targets" → done with result="found 35 candidates").
 * Operator calls this to skip a task ("don't bother finding named contacts;
 * generic info@ addresses are fine").
 *
 * Race-safe via atomic SQL UPDATE. The earlier shape was a classic
 * read-modify-write: read probe.planJson, mutate tasks[] in JS, write
 * the whole planJson back. Two concurrent callers (agent advancing
 * task A while operator skips task B) would each compute against the
 * pre-write state — the second writer's full-object replacement
 * clobbered the first writer's mutation. The SQL-level UPDATE here
 * rebuilds tasks[] in-place: jsonb_array_elements unrolls the array,
 * CASE rewrites only the row whose id matches, jsonb_agg reassembles.
 * Postgres serializes UPDATEs on the same row, so a second concurrent
 * call runs against the first writer's just-committed state and both
 * mutations survive.
 */
export async function markProbeTaskStatus(
  probeId: string,
  taskId: string,
  status: ProbeTask['status'],
  result?: string,
): Promise<MarketProbe | null> {
  const isCompleted = status === 'done' || status === 'skipped';
  const merge: Record<string, unknown> = { status };
  if (isCompleted) merge.completedAt = new Date().toISOString();
  if (result !== undefined) merge.result = result;
  const mergeJson = JSON.stringify(merge);
  // When reverting to pending/in_progress, drop the stale completedAt
  // — matches the prior JS behavior, where setting `completedAt:
  // undefined` in the spread caused JSON.stringify to drop the key.
  const elemExpr = isCompleted ? sql`elem` : sql`(elem - 'completedAt')`;
  await db.execute(sql`
    UPDATE market_probes
       SET plan_json = jsonb_set(
             COALESCE(plan_json, '{}'::jsonb),
             '{tasks}',
             COALESCE(
               (SELECT jsonb_agg(
                  CASE
                    WHEN elem->>'id' = ${taskId}
                    THEN ${elemExpr} || ${mergeJson}::jsonb
                    ELSE elem
                  END
                ) FROM jsonb_array_elements(plan_json->'tasks') elem),
               '[]'::jsonb
             )
           ),
           updated_at = NOW()
     WHERE id = ${probeId}
  `);
  const [row] = await db
    .select()
    .from(marketProbes)
    .where(eq(marketProbes.id, probeId))
    .limit(1);
  return row ?? null;
}

/**
 * Update the probe's status and cascade to any linked
 * conversation_settings rows. The earlier shape just flipped
 * marketProbes.status — leaving conversation_settings rows the
 * autopilot had created (with linkedProbeId pointing at this probe)
 * still aiEnabled and not paused. Result: probe finishes / is
 * abandoned, but inbound replies on those threads keep triggering
 * the AI auto-reply path as if the probe were still in flight.
 *
 * Cascade rules:
 *   - 'completed' / 'abandoned' / 'paused' → pause every linked
 *     conversation_settings (set pausedAt + pausedReason). Inbound
 *     replies still arrive in the inbox; they just route to operator
 *     review instead of triggering AI drafts.
 *   - 'active' → no automatic resume. Operator manually resumes
 *     any conversation they want to keep AI-driven, since a probe
 *     coming back from 'paused' may be testing different angles
 *     than the original convos that were active mid-probe.
 *
 * We don't unset linkedProbeId — it's a useful audit pointer
 * regardless of probe state, and the conversation might still
 * receive late-arriving replies that operators want routed to the
 * probe-aware reply path (escalation classifier, etc.).
 */
export async function setProbeStatus(
  probeId: string,
  status: MarketProbe['status'],
): Promise<void> {
  await db
    .update(marketProbes)
    .set({ status, updatedAt: new Date() })
    .where(eq(marketProbes.id, probeId));

  const shouldPauseLinked =
    status === 'completed' ||
    status === 'abandoned' ||
    status === 'paused';
  if (shouldPauseLinked) {
    await db
      .update(conversationSettings)
      .set({
        pausedAt: new Date(),
        pausedReason: `linked probe ${probeId} → ${status}`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(conversationSettings.linkedProbeId, probeId),
          // Don't bump pausedAt timestamps on conversations the
          // operator has already paused for an unrelated reason —
          // their pausedReason captures the operator's intent and
          // shouldn't be silently rewritten.
          isNull(conversationSettings.pausedAt),
        ),
      );
  }
}

export async function setProbeTier(
  probeId: string,
  tier: 0 | 1 | 2 | 3,
): Promise<void> {
  await db
    .update(marketProbes)
    .set({ tier, updatedAt: new Date() })
    .where(eq(marketProbes.id, probeId));
}

export async function deleteProbeTargetsNotIn(
  probeId: string,
  keepIds: string[],
): Promise<number> {
  // Used when the operator wants to refresh discovery and prune
  // targets that no longer rank — Phase 2. Phase 1 ships the helper
  // but the UI doesn't call it yet.
  if (keepIds.length === 0) {
    const removed = await db
      .delete(marketProbeTargets)
      .where(eq(marketProbeTargets.probeId, probeId))
      .returning({ id: marketProbeTargets.id });
    return removed.length;
  }
  const removed = await db
    .delete(marketProbeTargets)
    .where(
      and(
        eq(marketProbeTargets.probeId, probeId),
        sql`${marketProbeTargets.id} NOT IN (${sql.join(
          keepIds.map((id) => sql`${id}`),
          sql`, `,
        )})`,
      ),
    )
    .returning({ id: marketProbeTargets.id });
  return removed.length;
}
