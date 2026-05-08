import 'server-only';
import { and, desc, eq, sql } from 'drizzle-orm';
import {
  db,
  marketProbeMessageVariants,
  marketProbeTargets,
  type MarketProbeMessageVariant,
  type NewMarketProbeMessageVariant,
  type VariantStatus,
  VARIANT_STATUSES,
} from '@procur/db';
import { createId } from '@procur/ai';

export { VARIANT_STATUSES };
export type { VariantStatus, MarketProbeMessageVariant };

/**
 * Phase 2I.4 — message variant testing helpers.
 *
 * Operator authors 2-3 variants per probe (different subject lines,
 * outreach angles, tones); autopilot picks one per target via
 * weighted sampling at draft time and stamps the assignment on
 * market_probe_targets.variant_id. Per-variant outcomes aggregate
 * via the scorecard's variant-performance pass.
 *
 * Discipline: variants are operator-authored. The agent doesn't
 * propose new variants today (that's a future addition — the
 * Learning Report could nominate variants for the next probe).
 */

export interface CreateVariantInput {
  probeId: string;
  variantName: string;
  status?: VariantStatus;
  subjectTemplate?: string | null;
  bodyTemplate?: string | null;
  angle?: string | null;
  weight?: number;
  notes?: string | null;
  parentVariantId?: string | null;
  createdByUserId?: string | null;
}

export async function createVariant(
  input: CreateVariantInput,
): Promise<MarketProbeMessageVariant> {
  const row: NewMarketProbeMessageVariant = {
    id: createId(),
    probeId: input.probeId,
    variantName: input.variantName,
    status: input.status ?? 'active',
    subjectTemplate: input.subjectTemplate ?? null,
    bodyTemplate: input.bodyTemplate ?? null,
    angle: input.angle ?? null,
    weight: String(input.weight ?? 1),
    notes: input.notes ?? null,
    parentVariantId: input.parentVariantId ?? null,
    createdByUserId: input.createdByUserId ?? null,
  };
  const [created] = await db
    .insert(marketProbeMessageVariants)
    .values(row)
    .returning();
  if (!created) throw new Error('createVariant: no row returned');
  return created;
}

export async function listVariants(
  probeId: string,
): Promise<MarketProbeMessageVariant[]> {
  return await db
    .select()
    .from(marketProbeMessageVariants)
    .where(eq(marketProbeMessageVariants.probeId, probeId))
    .orderBy(desc(marketProbeMessageVariants.createdAt));
}

export async function setVariantStatus(input: {
  variantId: string;
  status: VariantStatus;
}): Promise<void> {
  if (input.status === 'winner') {
    // 'winner' is mutually exclusive — promoting one demotes the rest
    // to 'archived'. Atomically with a single SQL UPDATE keyed on
    // probe_id (subquery pulls the probe id from the target variant)
    // so concurrent two-operator promotes can't both succeed and
    // leave > 1 winner. CASE expression flips the chosen variant to
    // winner and every other active/paused variant to archived in
    // one statement.
    await db.execute(sql`
      UPDATE market_probe_message_variants
         SET status = CASE
                        WHEN id = ${input.variantId} THEN 'winner'
                        ELSE 'archived'
                      END,
             updated_at = NOW()
       WHERE probe_id = (
               SELECT probe_id FROM market_probe_message_variants
                WHERE id = ${input.variantId}
             )
         AND (id = ${input.variantId} OR status IN ('active', 'paused'))
    `);
    return;
  }
  await db
    .update(marketProbeMessageVariants)
    .set({ status: input.status, updatedAt: new Date() })
    .where(eq(marketProbeMessageVariants.id, input.variantId));
}

/**
 * Pick a variant for an outbound. Two paths:
 *
 *   1. If any 'winner' variant exists, return it directly. Operator
 *      already declared the test over.
 *   2. Otherwise weighted-sample among 'active' variants. Each row
 *      contributes weight = its `weight` column; cumulative random
 *      selection.
 *
 * Returns null when the probe has no eligible variants — caller
 * (autopilot) falls back to the plan-derived intent string from
 * Phase 2H. This preserves Phase 2H probes' behavior end-to-end.
 */
export async function pickVariantForTarget(
  probeId: string,
): Promise<MarketProbeMessageVariant | null> {
  const variants = await db
    .select()
    .from(marketProbeMessageVariants)
    .where(
      and(
        eq(marketProbeMessageVariants.probeId, probeId),
        sql`${marketProbeMessageVariants.status} IN ('active','winner')`,
      ),
    );
  if (variants.length === 0) return null;

  // Winner short-circuit.
  const winner = variants.find((v) => v.status === 'winner');
  if (winner) return winner;

  // Weighted sampling among active variants. Two edge cases the
  // earlier shape handled poorly:
  //   1. All weights = 0 (or negative) — earlier returned active[0]
  //      every time. Now: uniform-random fallback so each variant
  //      gets equal selection probability.
  //   2. Off-by-one in the loop's `roll <= 0` check — if a variant
  //      with weight 0 follows the matching one, `roll` could land
  //      exactly on 0 and the zero-weight variant would win. Fixed
  //      by using strict `<` and clamping each contribution to >= 0
  //      with epsilon so ties don't accidentally fall through.
  const active = variants.filter((v) => v.status === 'active');
  if (active.length === 0) return null;
  const weights = active.map((v) =>
    Math.max(0, Number(v.weight) || 0),
  );
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  if (totalWeight <= 0) {
    // Uniform-random fallback when all configured weights are zero.
    return active[Math.floor(Math.random() * active.length)]!;
  }
  let roll = Math.random() * totalWeight;
  for (let i = 0; i < active.length; i++) {
    if (weights[i]! <= 0) continue; // skip zero-weight variants
    roll -= weights[i]!;
    if (roll < 0) return active[i]!;
  }
  // Floating-point rounding edge case — return the last positive-
  // weight variant.
  for (let i = active.length - 1; i >= 0; i--) {
    if (weights[i]! > 0) return active[i]!;
  }
  return active[0]!;
}

export interface VariantPerformanceRow {
  variantId: string;
  variantName: string;
  status: string;
  sent: number;
  replied: number;
  positiveReplied: number;
  bounced: number;
  unsubscribed: number;
  replyRate: number;
  positiveReplyRate: number;
  bounceRate: number;
}

/**
 * Compute per-variant outcome rollup. Joined against
 * market_probe_targets so the SQL is one grouped scan per probe.
 * Surfaces in the probe scorecard (after Phase 2I.4 ships, the
 * scorecard panel renders this as a separate "Variant performance"
 * table). Phase 2I.4 ships the aggregator + UI; the existing
 * computeProbeScorecard doesn't yet incorporate it (deferred so this
 * PR stays additive — scorecard consumers update when they want).
 */
export async function computeVariantPerformance(
  probeId: string,
): Promise<VariantPerformanceRow[]> {
  const variants = await listVariants(probeId);
  if (variants.length === 0) return [];

  const targets = await db
    .select({
      variantId: marketProbeTargets.variantId,
      sendStatus: marketProbeTargets.sendStatus,
      replyStatus: marketProbeTargets.replyStatus,
    })
    .from(marketProbeTargets)
    .where(eq(marketProbeTargets.probeId, probeId));

  return variants.map((v) => {
    const mine = targets.filter((t) => t.variantId === v.id);
    const sent = mine.filter(
      (t) => t.sendStatus === 'sent' || t.sendStatus === 'queued',
    ).length;
    const bounced = mine.filter((t) => t.sendStatus === 'bounced').length;
    const replied = mine.filter(
      (t) =>
        t.replyStatus &&
        t.replyStatus !== 'none' &&
        t.replyStatus !== 'unsubscribe',
    ).length;
    const positive = mine.filter(
      (t) => t.replyStatus === 'positive' || t.replyStatus === 'routing',
    ).length;
    const unsubscribed = mine.filter(
      (t) => t.replyStatus === 'unsubscribe',
    ).length;
    const div = (n: number, d: number) => (d > 0 ? n / d : 0);
    return {
      variantId: v.id,
      variantName: v.variantName,
      status: v.status,
      sent,
      replied,
      positiveReplied: positive,
      bounced,
      unsubscribed,
      replyRate: div(replied, sent),
      positiveReplyRate: div(positive, sent),
      bounceRate: div(bounced, sent),
    };
  });
}
