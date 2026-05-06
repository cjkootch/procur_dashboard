import { eq } from 'drizzle-orm';
import {
  db,
  events,
  fuelDealMarketContext,
  fuelDealScenarios,
  fuelDeals,
} from '@procur/db';
import { createId } from '../id';
import type { AgentContext, AgentOutput, IAgent } from '../types';

/**
 * Procur's `evaluateTargetPrice` lives in `@procur/catalog`, which
 * already depends on `@procur/ai` (for createId, embedText,
 * defineTool, …). To avoid a workspace cycle, the agent doesn't
 * import the helper directly — the caller (apps/app server action)
 * passes it in. The type below mirrors `EvaluateTargetPriceInput` /
 * `EvaluateTargetPriceResult` from @procur/catalog/plausibility.ts;
 * keep them in sync if the catalog signature changes.
 */
type ProductSlug =
  | 'en590-ulsd'
  | 'gasoline-super'
  | 'jet-a1'
  | 'kerosene'
  | 'gasoil-0.5pct'
  | 'hsfo'
  | 'crude-light-sweet'
  | 'crude-medium-sour';

export type EvaluateTargetPriceFn = (input: {
  product: ProductSlug;
  targetCifUsdPerBbl?: number;
  targetCifUsdPerMt?: number;
  destPortSlug: string;
  volumeUsg?: number;
}) => Promise<{
  benchmarkSlug: string;
  benchmarkSpotUsdPerBbl: number | null;
  realisticCifUsdPerBbl: { low: number; mid: number; high: number } | null;
  pctGapVsMid: number | null;
  verdict:
    | 'overpriced'
    | 'plausible'
    | 'aggressive'
    | 'unrealistic'
    | 'scam-flag'
    | 'no-data'
    | 'no-target';
  narrative: string;
}>;

/**
 * Per docs/vex-into-procur-merge-brief.md Phase 5. Procur-side
 * port of vex's DealMarketContextAgent (vex's source has the
 * `fuel_deal_market_context` schema but no agent code; this design
 * comes from the schema columns + procur's existing
 * `evaluateTargetPrice` plausibility helper).
 *
 * Trigger: on demand (chat tool, draft→live transition, or operator
 * "re-evaluate" button). T0 — read-only, queries procur's own
 * benchmark price + freight tables and writes a single row to
 * `fuel_deal_market_context`. Idempotent on the unique index
 * (deal_id) so re-runs upsert in place.
 *
 * Output verdict values (per Phase 1 schema): aggressive |
 * competitive | fair | high | outlier_high. Maps from
 * evaluateTargetPrice's verdict by direction:
 *
 *   evaluateTargetPrice         fuel_deal_market_context.verdict
 *   ─────────────────────────   ─────────────────────────────────
 *   overpriced (>+10%)          high
 *   plausible (-5% .. +10%)     fair
 *   aggressive (-15% .. -5%)    competitive
 *   unrealistic (-30% .. -15%)  aggressive
 *   scam-flag (<-30%)           outlier_high
 *   no-data / no-target         (no row written)
 */

const PRODUCT_SLUG_MAP: Record<string, ProductSlug | null> = {
  ulsd: 'en590-ulsd',
  gasoline_87: 'gasoline-super',
  gasoline_91: 'gasoline-super',
  jet_a: 'jet-a1',
  jet_a1: 'jet-a1',
  avgas: null,
  lfo: 'gasoil-0.5pct',
  hfo: 'hsfo',
  lng: null,
  lpg: null,
  biodiesel_b20: null,
  // Food line of business — no benchmark in plausibility.ts
  rice: null,
  beans: null,
  pork: null,
  chicken: null,
  cooking_oil: null,
  powdered_milk: null,
};

function mapVerdict(
  v:
    | 'overpriced'
    | 'plausible'
    | 'aggressive'
    | 'unrealistic'
    | 'scam-flag'
    | 'no-data'
    | 'no-target',
): 'aggressive' | 'competitive' | 'fair' | 'high' | 'outlier_high' | null {
  switch (v) {
    case 'overpriced':
      return 'high';
    case 'plausible':
      return 'fair';
    case 'aggressive':
      return 'competitive';
    case 'unrealistic':
      return 'aggressive';
    case 'scam-flag':
      return 'outlier_high';
    case 'no-data':
    case 'no-target':
      return null;
  }
}

export interface DealMarketContextInput {
  dealId: string;
  scenarioId?: string;
}

export interface DealMarketContextDeps {
  /** Injected by the caller from `@procur/catalog`. */
  evaluateTargetPrice: EvaluateTargetPriceFn;
}

export class DealMarketContextAgent implements IAgent {
  readonly name = 'deal_market_context';
  readonly tier = 'T0' as const;

  constructor(
    private readonly input: DealMarketContextInput,
    private readonly deps: DealMarketContextDeps,
  ) {}

  async run(ctx: AgentContext): Promise<AgentOutput> {
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

    const productSlug = PRODUCT_SLUG_MAP[deal.product];
    if (!productSlug) {
      return {
        proposedActions: [],
        internalWrites: 0,
        costUsd: 0,
        outputRefs: {
          skipped: 'product_not_benchmarkable',
          deal_id: deal.id,
          product: deal.product,
        },
        rationale: `${deal.product} has no benchmark in plausibility.ts; market context not applicable`,
      };
    }

    const scenario = await pickScenario(deal.id, this.input.scenarioId);
    if (!scenario) {
      return {
        proposedActions: [],
        internalWrites: 0,
        costUsd: 0,
        outputRefs: { skipped: 'no_active_scenario', deal_id: deal.id },
        rationale: `deal ${deal.dealRef} has no active scenario`,
      };
    }

    if (!deal.destinationPort) {
      return {
        proposedActions: [],
        internalWrites: 0,
        costUsd: 0,
        outputRefs: { skipped: 'no_destination_port', deal_id: deal.id },
        rationale: `deal ${deal.dealRef} has no destination_port — can't price benchmark`,
      };
    }

    // Convert sell_price_per_usg to sell_price_per_bbl for the
    // plausibility engine (it expects USD/MT or USD/bbl input).
    const sellPricePerBbl = scenario.sellPricePerUsg * 42;

    const evalResult = await this.deps.evaluateTargetPrice({
      product: productSlug,
      targetCifUsdPerBbl: sellPricePerBbl,
      destPortSlug: deal.destinationPort,
      volumeUsg: scenario.volumeUsgOverride ?? deal.volumeUsg,
    });

    const procurVerdict = mapVerdict(evalResult.verdict);
    if (!procurVerdict) {
      return {
        proposedActions: [],
        internalWrites: 0,
        costUsd: 0,
        outputRefs: {
          skipped: 'no_benchmark_data',
          deal_id: deal.id,
          inner_verdict: evalResult.verdict,
        },
        rationale: `${deal.dealRef}: ${evalResult.verdict} — insufficient benchmark / freight data`,
      };
    }

    const benchmarkSpotUsd = evalResult.benchmarkSpotUsdPerBbl;
    const effectiveBenchmarkUsd =
      evalResult.realisticCifUsdPerBbl?.mid ?? null;
    const offerDeltaUsd =
      effectiveBenchmarkUsd !== null
        ? sellPricePerBbl - effectiveBenchmarkUsd
        : null;
    const offerDeltaPct = evalResult.pctGapVsMid;

    // Idempotent upsert on (deal_id) — Phase 1 unique index.
    const existing = await db
      .select({ id: fuelDealMarketContext.id })
      .from(fuelDealMarketContext)
      .where(eq(fuelDealMarketContext.dealId, deal.id))
      .limit(1);

    const occurredAt = ctx.now();
    if (existing[0]) {
      await db
        .update(fuelDealMarketContext)
        .set({
          benchmarkCode: evalResult.benchmarkSlug,
          benchmarkSpotUsd,
          effectiveBenchmarkUsd,
          offerDeltaUsd,
          offerDeltaPct,
          verdict: procurVerdict,
          rationale: evalResult.narrative,
          fetchedAt: occurredAt,
        })
        .where(eq(fuelDealMarketContext.id, existing[0].id));
    } else {
      await db.insert(fuelDealMarketContext).values({
        id: createId(),
        dealId: deal.id,
        benchmarkCode: evalResult.benchmarkSlug,
        benchmarkSpotUsd,
        effectiveBenchmarkUsd,
        offerDeltaUsd,
        offerDeltaPct,
        verdict: procurVerdict,
        rationale: evalResult.narrative,
      });
    }

    await db
      .insert(events)
      .values({
        id: createId(),
        verb: 'deal.market_context_recomputed',
        subjectType: 'fuel_deal',
        subjectId: deal.id,
        actorType: 'system',
        actorId: this.name,
        objectType: 'fuel_deal_market_context',
        objectId: deal.id,
        occurredAt,
        idempotencyKey: `deal.market_context:${deal.id}:${ctx.agentRunId}`,
        metadata: {
          benchmark: evalResult.benchmarkSlug,
          verdict: procurVerdict,
          inner_verdict: evalResult.verdict,
          offer_delta_pct: offerDeltaPct,
        },
      })
      .onConflictDoNothing({
        target: [events.occurredAt, events.idempotencyKey],
      });

    await ctx.costLedger.record({
      idempotencyKey: `deal_market_context:${ctx.agentRunId}`,
      agentRunId: ctx.agentRunId,
      operation: 'llm.completion',
      provider: 'procur.plausibility',
      model: 'evaluate_target_price.v1',
      units: 0,
      unitKind: 'computations',
      costUsdMicros: 0,
      occurredAt,
    });

    return {
      proposedActions: [],
      internalWrites: 1,
      costUsd: 0,
      outputRefs: {
        deal_id: deal.id,
        deal_ref: deal.dealRef,
        verdict: procurVerdict,
        benchmark: evalResult.benchmarkSlug,
        offer_delta_pct: offerDeltaPct,
      },
      rationale: `${deal.dealRef}: ${procurVerdict} (${evalResult.benchmarkSlug})`,
    };
  }
}

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
  const rows = await db
    .select()
    .from(fuelDealScenarios)
    .where(eq(fuelDealScenarios.dealId, dealId));
  return rows.find((r) => r.isActive) ?? rows[0];
}
