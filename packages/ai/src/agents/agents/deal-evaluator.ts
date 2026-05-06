import { eq } from 'drizzle-orm';
import {
  db,
  events,
  fuelDealCostStack,
  fuelDealScenarios,
  fuelDeals,
  summaries,
} from '@procur/db';
import {
  calculateFuelDeal,
  type FuelDealInputs,
  type FuelDealResults,
  type DealWarning,
} from '@procur/pricing';
import type { ActionDescriptorT } from '../action-descriptor';
import { createId } from '../id';
import type { AgentContext, AgentOutput, IAgent } from '../types';

/**
 * Per docs/vex-into-procur-merge-brief.md Phase 5. Ported from vex's
 * `packages/agents/src/agents/deal-evaluator.ts`. Trimmed for procur:
 * the per-tenant repository bag goes away (Phase 0 single-user scope);
 * persistence flows through @procur/db drizzle directly. The pure
 * calculator (`@procur/pricing.calculateFuelDeal`) is unchanged and
 * was ported earlier as part of @procur/pricing.
 *
 * Lifecycle:
 *   1. Fetch deal + active scenario + cost stack
 *   2. Build FuelDealInputs from persisted rows
 *   3. Run the calculator (pure, deterministic)
 *   4. Persist results_json + score + recommendation on the scenario row
 *   5. If any critical OFAC/BIS warning fires, set deal.complianceHold
 *   6. Upsert a one-paragraph summary into the summaries table
 *   7. If recommendation === 'do_not_proceed', emit a T2
 *      `deal.human_review` proposed action — the AgentRunner routes it
 *      through ApprovalGate so a human acknowledges before any
 *      downstream status change.
 *   8. Audit event (`deal.evaluated`) with a deterministic idempotency key
 *   9. Cost ledger zero-cost entry (no LLM — calculator is deterministic)
 */

const DEFAULT_THRESHOLDS = {
  maxPeakCashExposureUsd: 5_000_000,
  minGrossMarginPct: 0.05,
  minNetMarginPerUsg: 0.03,
  maxCounterpartyRiskScore: 65,
  maxCountryRiskScore: 70,
  maxDemurrageDays: 2,
} as const;

const DEFAULT_MONTHLY_OVERHEAD_USD = 120_000;

export interface DealEvaluatorInput {
  /** Deal to evaluate. Required. */
  dealId: string;
  /** Optional scenario override — when omitted, picks the active scenario. */
  scenarioId?: string;
}

export class DealEvaluatorAgent implements IAgent {
  readonly name = 'deal_evaluator';
  readonly tier = 'T1' as const;

  constructor(private readonly input: DealEvaluatorInput) {}

  async run(ctx: AgentContext): Promise<AgentOutput> {
    // 1. Deal
    const dealRows = await db
      .select()
      .from(fuelDeals)
      .where(eq(fuelDeals.id, this.input.dealId))
      .limit(1);
    const deal = dealRows[0];
    if (!deal) {
      return {
        proposedActions: [],
        internalWrites: 0,
        costUsd: 0,
        outputRefs: { skipped: 'deal_not_found', deal_id: this.input.dealId },
        rationale: `deal ${this.input.dealId} not found`,
      };
    }

    // 2. Scenario — specified id, else the active row for this deal.
    const scenario = await pickScenario(deal.id, this.input.scenarioId);
    if (!scenario) {
      return {
        proposedActions: [],
        internalWrites: 0,
        costUsd: 0,
        outputRefs: { skipped: 'no_active_scenario', deal_id: deal.id },
        rationale: `deal ${deal.dealRef} has no active scenario to evaluate`,
      };
    }

    // 3. Cost stack — one row per deal (Phase 1 schema).
    const stackRows = await db
      .select()
      .from(fuelDealCostStack)
      .where(eq(fuelDealCostStack.dealId, deal.id))
      .limit(1);
    const costStack = stackRows[0];
    if (!costStack) {
      return {
        proposedActions: [],
        internalWrites: 0,
        costUsd: 0,
        outputRefs: { skipped: 'no_cost_stack', deal_id: deal.id },
        rationale: `deal ${deal.dealRef} has no cost stack`,
      };
    }

    // 4. Build inputs + run the deterministic calculator.
    const inputs = buildInputs({ deal, scenario, costStack });
    const results = calculateFuelDeal(inputs);

    let internalWrites = 0;

    // 5. Persist results on the scenario row. Idempotent — re-running
    //    against unchanged inputs produces byte-identical results_json.
    await db
      .update(fuelDealScenarios)
      .set({
        resultsJson: results as unknown as Record<string, unknown>,
        score: results.scorecard.overallScore,
        recommendation: results.scorecard.recommendation,
        calculatedAt: ctx.now(),
        updatedAt: ctx.now(),
      })
      .where(eq(fuelDealScenarios.id, scenario.id));
    internalWrites += 1;

    // 6. Compliance hold — any critical OFAC/BIS warning flips the
    //    deal-level flag so downstream tooling can filter blocked deals
    //    without re-running the calculator.
    const complianceCritical = results.warnings.some(
      (w) =>
        w.severity === 'critical' &&
        (w.code.startsWith('ofac.') || w.code.startsWith('bis.')),
    );
    if (complianceCritical && !deal.complianceHold) {
      await db
        .update(fuelDeals)
        .set({ complianceHold: true, updatedAt: ctx.now() })
        .where(eq(fuelDeals.id, deal.id));
      internalWrites += 1;
    }

    // 7. Summary — one paragraph, deterministic template. Upsert via
    //    the (subject_type, subject_id, summary_type, version) unique
    //    index in Phase 1 schema. Phase 5 evaluator always writes
    //    version 1; future versioning can layer on if recommendations
    //    diverge on re-runs.
    const summaryId = createId();
    const summaryContent = buildSummaryText(deal, results);
    await db
      .insert(summaries)
      .values({
        id: summaryId,
        subjectType: 'fuel_deal',
        subjectId: deal.id,
        summaryType: 'deal_evaluation',
        version: 1,
        content: summaryContent,
      })
      .onConflictDoNothing({
        target: [
          summaries.subjectType,
          summaries.subjectId,
          summaries.summaryType,
          summaries.version,
        ],
      });
    // If we conflicted (existing row), update the content in place.
    await db
      .update(summaries)
      .set({ content: summaryContent, updatedAt: ctx.now() })
      .where(
        eq(summaries.subjectType, 'fuel_deal') &&
          eq(summaries.subjectId, deal.id) &&
          eq(summaries.summaryType, 'deal_evaluation'),
      );
    internalWrites += 1;

    // 8. do_not_proceed → propose T2 human-review approval.
    const proposedActions: ActionDescriptorT[] = [];
    if (results.scorecard.recommendation === 'do_not_proceed') {
      proposedActions.push({
        kind: 'deal.human_review',
        tier: 'T2',
        dealId: deal.id,
        dealRef: deal.dealRef,
        score: results.scorecard.overallScore,
        recommendation: results.scorecard.recommendation,
        reason: results.scorecard.recommendationReason,
        criticalWarnings: results.warnings
          .filter((w) => w.severity === 'critical')
          .slice(0, 20)
          .map((w) => ({ code: w.code, message: w.message })),
        rationale: `Deal ${deal.dealRef} flagged do_not_proceed: ${results.scorecard.recommendationReason}`,
      });
    }

    // 9. Audit event — idempotency key tied to (deal, scenario,
    //    agentRunId) so re-runs emit once per run but never duplicate.
    const occurredAt = ctx.now();
    await db
      .insert(events)
      .values({
        id: createId(),
        verb: 'deal.evaluated',
        subjectType: 'fuel_deal',
        subjectId: deal.id,
        actorType: 'system',
        actorId: this.name,
        objectType: 'fuel_deal_scenario',
        objectId: scenario.id,
        occurredAt,
        idempotencyKey: `deal.evaluated:${deal.id}:${scenario.id}:${ctx.agentRunId}`,
        metadata: {
          deal_ref: deal.dealRef,
          score: results.scorecard.overallScore,
          recommendation: results.scorecard.recommendation,
          warnings_critical: results.warnings.filter(
            (w) => w.severity === 'critical',
          ).length,
          warnings_caution: results.warnings.filter(
            (w) => w.severity === 'caution',
          ).length,
          compliance_hold: complianceCritical,
        },
      })
      .onConflictDoNothing({
        target: [events.occurredAt, events.idempotencyKey],
      });

    // 10. Cost ledger — zero-cost (deterministic calculator, no LLM).
    //     Recorded so the ledger reflects every agent run for audit.
    await ctx.costLedger.record({
      idempotencyKey: `deal_evaluator:${ctx.agentRunId}`,
      agentRunId: ctx.agentRunId,
      operation: 'llm.completion',
      provider: 'procur.calculator',
      model: 'fuel_deal_calculator.v1',
      units: 0,
      unitKind: 'computations',
      costUsdMicros: 0,
      occurredAt,
    });

    return {
      proposedActions,
      internalWrites,
      costUsd: 0,
      outputRefs: {
        deal_id: deal.id,
        deal_ref: deal.dealRef,
        scenario_id: scenario.id,
        score: results.scorecard.overallScore,
        recommendation: results.scorecard.recommendation,
        warnings_total: results.warnings.length,
        compliance_hold: complianceCritical,
      },
      rationale: `${deal.dealRef}: ${results.scorecard.recommendation} (${results.scorecard.overallScore.toFixed(1)})`,
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function pickScenario(
  dealId: string,
  scenarioIdOverride: string | undefined,
): Promise<typeof fuelDealScenarios.$inferSelect | undefined> {
  if (scenarioIdOverride) {
    const rows = await db
      .select()
      .from(fuelDealScenarios)
      .where(eq(fuelDealScenarios.id, scenarioIdOverride))
      .limit(1);
    return rows[0];
  }
  // Pick the active scenario for this deal (is_active = true). If
  // multiple are flagged active (shouldn't happen but defensive),
  // the most-recently-updated wins.
  const rows = await db
    .select()
    .from(fuelDealScenarios)
    .where(eq(fuelDealScenarios.dealId, dealId));
  return rows.find((r) => r.isActive) ?? rows[0];
}

interface BuildInputsArgs {
  deal: typeof fuelDeals.$inferSelect;
  scenario: typeof fuelDealScenarios.$inferSelect;
  costStack: typeof fuelDealCostStack.$inferSelect;
}

function buildInputs({
  deal,
  scenario,
  costStack,
}: BuildInputsArgs): FuelDealInputs {
  const volumeUsg = scenario.volumeUsgOverride ?? deal.volumeUsg;
  const productCostPerUsg =
    scenario.productCostOverride ?? costStack.productCostPerUsg;
  const freightPerUsg =
    scenario.freightOverridePerUsg ?? costStack.freightRatePerUsg;
  const fxRateToUsd = scenario.fxRateOverride ?? deal.fxRateToUsd;

  const inputs: FuelDealInputs = {
    dealRef: deal.dealRef,
    product: deal.product,
    incoterm: deal.incoterm,
    volumeUsg,
    // Density is nullable for food deals; calculator clamps to 0.
    densityKgL: deal.densityKgL ?? 0,
    volumeTolerancePct: deal.volumeTolerancePct,
    sellPricePerUsg: scenario.sellPricePerUsg,
    buyerCurrencyCode: deal.currency,
    fxRateToUsd,
    fxHedgeInPlace: deal.fxHedgeInPlace,
    productCostPerUsg,
    productQualityPremiumPerUsg: costStack.productQualityPremiumUsg,
    freightPerUsg,
    cargoInsurancePct: costStack.cargoInsurancePct,
    warRiskPremiumPct: costStack.warRiskPremiumPct ?? 0,
    politicalRiskPremiumPct: costStack.politicalRiskPremiumPct ?? 0,
    dischargeHandlingPerUsg: costStack.dischargeHandlingPerUsg,
    compliancePerUsg: costStack.totalCompliancePerUsg,
    tradeFinancePerUsg: costStack.tradeFinancePerUsg,
    intermediaryFeePerUsg: costStack.totalAgentPerUsg,
    vtcVariableOpsPerUsg: costStack.vtcVariableOpsPerUsg,
    overheadAllocationUsd: costStack.overheadAllocationUsd,
    tradeFinance: {
      type: deal.paymentTerms,
      ...(deal.lcValueUsd !== null ? { lcValueUsd: deal.lcValueUsd } : {}),
      ...(deal.lcMarginPct !== null ? { lcMarginPct: deal.lcMarginPct } : {}),
    },
    counterpartyRiskScore: deal.counterpartyRiskScore ?? 0,
    countryRiskScore: deal.countryRiskScore ?? 0,
    thresholds: { ...DEFAULT_THRESHOLDS },
    monthlyFixedOverheadUsd: DEFAULT_MONTHLY_OVERHEAD_USD,
    compliance: {
      ofac: deal.ofacScreeningStatus,
      bisRequired: deal.bisLicenseRequired,
      bisIssued: deal.bisLicenseNumber !== null,
      eeiRequired: deal.eeiFilingRequired,
      eeiFiled: deal.eeiItn !== null,
    },
  };

  if (
    costStack.vesselCapacityUsg !== null &&
    costStack.vesselUtilizationPct !== null
  ) {
    inputs.vessel = {
      capacityUsg: costStack.vesselCapacityUsg,
      utilizationPct: costStack.vesselUtilizationPct,
      freightLumpSumUsd: costStack.freightRateRaw,
      demurrageRatePerDay: costStack.demurrageRatePerDay ?? 0,
      demurrageEstimatedDays: costStack.demurrageDaysEstimated ?? 0,
      despatchRatePerDay: costStack.despatchRatePerDay ?? 0,
      portDuesLoadUsd: costStack.portDuesLoadUsd ?? 0,
      portDuesDischargeUsd: costStack.portDuesDischargeUsd ?? 0,
      canalTransitUsd: costStack.canalTransitCostUsd ?? 0,
    };
  }

  return inputs;
}

function buildSummaryText(
  deal: typeof fuelDeals.$inferSelect,
  results: FuelDealResults,
): string {
  const top3 = rankedWarnings(results.warnings).slice(0, 3);
  const warningsPart =
    top3.length > 0
      ? ' Top warnings: ' +
        top3.map((w) => `${w.message} (${w.severity})`).join('; ') +
        '.'
      : ' No warnings.';
  const score = results.scorecard.overallScore.toFixed(1);
  return (
    `${deal.dealRef} (${deal.product.toUpperCase()}, ${(
      deal.volumeUsg / 1_000_000
    ).toFixed(2)}M USG ${deal.incoterm.toUpperCase()} ${deal.destinationPort ?? 'destination TBD'}): ` +
    `${results.scorecard.recommendation.replace(/_/g, ' ')}. ` +
    `Score ${score}/100. ` +
    `Net margin $${results.perUsg.netMargin.toFixed(4)}/USG, ` +
    `EBITDA $${Math.round(results.totals.ebitdaUsd).toLocaleString('en-US')}.` +
    warningsPart
  );
}

function rankedWarnings(warnings: DealWarning[]): DealWarning[] {
  const rank: Record<DealWarning['severity'], number> = {
    critical: 0,
    caution: 1,
    info: 2,
  };
  return [...warnings].sort((a, b) => rank[a.severity] - rank[b.severity]);
}
