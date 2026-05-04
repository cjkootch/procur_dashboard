import 'server-only';

import { db } from '@procur/db';
import {
  calculateFuelDeal,
  getBenchmarkPrice,
  USG_PER_BBL,
  type FuelDealInputs,
  type FuelDealResults,
  type ProductType,
} from '@procur/pricing';

import type { FreightOriginRegion } from './freight-routes';
import { getCommodityPriceContext, getDensityForCrudeName } from './queries';

/**
 * LLM-friendly input shape for `compose_deal_economics`. A small subset of
 * the calculator's full `FuelDealInputs` — the rest are filled by sensible
 * defaults so the assistant only has to provide what the user actually
 * mentioned (typical: product, volume, sell price, product cost, freight).
 */
export type ComposeDealInput = {
  product: ProductType;
  /** Provide volumeUsg OR volumeBbls OR volumeMt. */
  volumeUsg?: number;
  volumeBbls?: number;
  /** Volume in metric tonnes — useful for buyer RFQs that quote in MT.
      Internally converted to USG via the resolved product density. */
  volumeMt?: number;
  /** Provide one of these for the sell price. */
  sellPricePerUsg?: number;
  sellPricePerBbl?: number;
  /** Optional. If omitted, we pull today's benchmark spot. */
  productCostPerUsg?: number;
  productCostPerBbl?: number;
  freightPerUsg?: number;
  freightRateUsdPerMt?: number;
  /** Per-deal density. Defaulted by product if omitted. */
  densityKgL?: number;
  incoterm?: FuelDealInputs['incoterm'];
  /** $/day × days. Either both or neither. */
  demurrageDays?: number;
  demurrageRatePerDay?: number;
  /** Variable cost-stack overrides ($/USG). All optional, default 0. */
  dischargeHandlingPerUsg?: number;
  compliancePerUsg?: number;
  tradeFinancePerUsg?: number;
  intermediaryFeePerUsg?: number;
  vtcVariableOpsPerUsg?: number;
  /** Risk + governance overrides. Sensible defaults applied. */
  counterpartyRiskScore?: number;
  countryRiskScore?: number;
  monthlyFixedOverheadUsd?: number;
  /** YYYY-MM-DD. If omitted we use today. Used for benchmark lookup. */
  asOf?: string;
  /** Free-form deal label that flows into the result. */
  dealRef?: string;
  /**
   * Sourcing region for the cargo. Drives which cost model we use as
   * the productCost fallback when neither productCostPerUsg nor
   * productCostPerBbl is supplied:
   *   - 'usgc' → NYH spot benchmark MINUS the typical USGC-vs-NYH
   *     basis differential (~5-8¢/USG depending on product). The
   *     EIA `nyh-*` series are literally NY Harbor; USGC trades at
   *     a known discount, and not adjusting for it overstates the
   *     productCost by 5-15¢/USG (false do_not_proceed verdicts in
   *     prior chat traces). See USGC_VS_NYH_BASIS_USG.
   *   - omitted → NYH spot, no adjustment (the conservative default
   *     when origin is unknown or genuinely NY Harbor).
   *   - any other origin → Brent + typical crack spread (matches the
   *     ex-refinery cost model in plausibility.ts; closer to reality
   *     for Med/Mideast/India/Singapore-origin cargoes where NYH spot
   *     overstates cost by $15-25/bbl).
   * Pass an explicit productCostPer* to override any of these models.
   */
  sourcingRegion?: FreightOriginRegion;
  /**
   * Opt-in to model a wash sale (sellPrice == auto-defaulted product
   * cost within 1¢/USG). By default the calculator refuses this
   * combination and asks for either a real productCost (supplier FOB)
   * or a sellPrice anchored on the realistic CIF mid — sell == cost
   * is not a deal, it's a wash, and the resulting do_not_proceed
   * verdict in chat traces has been confusing operators.
   *
   * Only set true when you explicitly want the wash modeled (e.g. to
   * see the freight + insurance drag on a hypothetical zero-margin
   * lift). When the user supplied productCost AND sellPrice both
   * explicitly, this guard does not fire — those are user inputs,
   * not auto-defaults.
   */
  allowWashSale?: boolean;
  /**
   * Named crude (e.g. "Brent", "Bonny Light", "Ekofisk") for which to
   * auto-fill `densityKgL` from the most recent producer-published
   * assay. Used when the user passes `volumeMt` for a crude cargo and
   * doesn't know the density off-hand — pulling from the assay table
   * is more accurate than the per-product hard-coded default
   * (~0.85 kg/L generic), especially for light condensates (~0.74)
   * and heavy crudes (~0.92+).
   *
   * `densityKgL` always wins when both are supplied. The lookup is
   * substring-match against assay name AND linked crude_grades.name,
   * so "brent", "Brent Blend", and "BRENT" all hit the same row.
   * Falls through silently to the per-product default when no
   * matching assay exists.
   */
  cargoCrudeName?: string;
};

export type ComposeDealResult = {
  inputs: FuelDealInputs;
  results: FuelDealResults;
  benchmark: {
    slug: string;
    asOf: string;
    pricePerUsg: number;
    pricePerBbl: number;
    /**
     * Whether the resolved benchmark was used as the productCost.
     * False means the caller supplied a productCost explicitly; the
     * benchmark is returned for context/comparison only.
     */
    usedAsProductCost: boolean;
  } | null;
  /**
   * Top-level critical signal the model should lead with in chat —
   * separate from `results.warnings` which are calculator-internal.
   * Today: surfaces "sell price below product cost" upfront so the
   * model can't silently present a guaranteed-loss deal as "the
   * plan." Null when the deal economics are coherent.
   */
  topLevelWarning: string | null;
  /** When `cargoCrudeName` resolved to a producer assay, the
   *  density used + its provenance. Null when the per-product
   *  default was used. Useful for chat surfaces that want to show
   *  "density 0.832 kg/L (Equinor EKOFISK 2015 06)". */
  densitySource: {
    densityKgL: number;
    source: string;
    reference: string;
    assayName: string;
  } | null;
  /** Tells the client renderer this is a deal-economics output. */
  kind: 'deal_economics';
};

/**
 * Per-company defaults that the assistant tool handler resolves once
 * (from `companies` row) and passes alongside the per-call input.
 * Each field is applied only when the equivalent per-call value is
 * unset — the user can always override on a per-deal basis.
 */
export type CompanyDealDefaults = {
  /** Falls back into ComposeDealInput.sourcingRegion. */
  defaultSourcingRegion?: FreightOriginRegion | null;
  /** Falls into thresholds.minGrossMarginPct. Decimal (0.05 = 5%). */
  targetGrossMarginPct?: number | null;
  /** Falls into thresholds.minNetMarginPerUsg. */
  targetNetMarginPerUsg?: number | null;
  /** Falls into FuelDealInputs.monthlyFixedOverheadUsd. */
  monthlyFixedOverheadUsdDefault?: number | null;
};

/**
 * Mid-point USGC-vs-NYH basis ($/USG, signed). Subtract this from
 * the NYH spot when the cargo is being lifted from USGC, since the
 * `nyh-diesel` / `nyh-gasoline` / `nyh-heating-oil` series are
 * literally NY Harbor (per `ingest-eia-prices.ts` — Y35NY duoarea)
 * and USGC trades at a known discount to NYH for refined product
 * (Gulf Coast has surplus refining capacity that ships into NYH).
 *
 * Typical published EIA spot deltas (5y avg, mid-band):
 *   - ULSD: USGC trades ~$0.05-$0.15/gal below NYH → -$0.08/USG
 *   - RBOB gasoline: ~$0.03-$0.08/gal below → -$0.05/USG
 *     (NYH carries a modest CAA RFG premium)
 *   - Heating oil / kerosene: ~$0.05-$0.10 → -$0.06/USG
 *
 * `null` for products not on the NYH refined-product feed
 * (jet, hfo, lng, lpg, biodiesel, food) — those either route through
 * the Brent+crack path or require an explicit productCost.
 *
 * Refresh cadence: review quarterly against EIA's PADD3-vs-PADD1B
 * spot diffs; widen if PADD3 storage tightness inverts the basis.
 *
 * The "5–15¢/USG overstatement" this fixes was tracked in the chat
 * traces where USGC-origin diesel deals showed do_not_proceed
 * verdicts because the auto-defaulted productCost (NYH) was 8-10¢
 * higher than the actual USGC supplier FOB.
 */
const USGC_VS_NYH_BASIS_USG: Record<ProductType, number | null> = {
  ulsd: -0.08,
  gasoline_87: -0.05,
  gasoline_91: -0.05,
  kerosene: -0.06,
  lfo: -0.06,
  // No NYH benchmark for these — adjustment N/A.
  jet_a: null,
  jet_a1: null,
  avgas: null,
  hfo: null,
  lng: null,
  lpg: null,
  biodiesel_b20: null,
  // Crude doesn't price off NYH refined-product spot — the model
  // anchors via Brent + crude differential (call get_crude_basis
  // upstream and pass productCostPerBbl explicitly).
  crude_light_sweet: null,
  crude_medium_sour: null,
  crude_heavy: null,
  rice: null,
  beans: null,
  pork: null,
  chicken: null,
  cooking_oil: null,
  powdered_milk: null,
};

/**
 * Mid-point crack spread (USD/bbl over Brent) per product. Mirrors
 * the bands in `plausibility.ts` (the source of truth) — see
 * `CRACK_SPREAD_USD_BBL` there for the low/high range. We keep an
 * inline copy keyed by ProductType to avoid the ProductType ↔
 * ProductSlug enum coupling between deal-economics and plausibility.
 *
 * `null` for products without a meaningful Brent-relative crack
 * (LNG, LPG, biodiesel, food-line) — the Brent+crack fallback is
 * skipped for those and we fall through to the NYH benchmark.
 *
 * Refresh cadence: keep in sync with plausibility.ts.
 */
const CRACK_SPREAD_MID_USD_BBL: Record<ProductType, number | null> = {
  ulsd: 18.5, // (15+22)/2
  gasoline_87: 14, // (10+18)/2
  gasoline_91: 14,
  jet_a: 21.5, // (18+25)/2
  jet_a1: 21.5,
  kerosene: 18.5, // tracks middle distillate
  avgas: null,
  lfo: 14, // gasoil-0.5pct band
  hfo: -6.5, // residual trades at a discount
  lng: null,
  lpg: null,
  biodiesel_b20: null,
  // Crude IS the Brent+crack input for refined products — there's
  // no crack spread on crude itself. productCost for crude trades
  // anchors on get_crude_basis (Brent + structural differential)
  // and the calculator requires it to be supplied explicitly.
  crude_light_sweet: null,
  crude_medium_sour: null,
  crude_heavy: null,
  rice: null,
  beans: null,
  pork: null,
  chicken: null,
  cooking_oil: null,
  powdered_milk: null,
};

/** L per metric tonne (1 MT = 1000 kg / density). */
function litresPerMt(densityKgL: number): number {
  return 1000 / densityKgL;
}

/** USG per metric tonne, given density. 1 L = 0.264172 USG. */
function usgPerMt(densityKgL: number): number {
  return litresPerMt(densityKgL) * 0.264172;
}

/**
 * Build a fully-populated FuelDealInputs from a sparse user-facing
 * input record, then run the calculator and return both the resolved
 * inputs and the results. The resolved inputs are echoed back so the
 * client renderer can re-run the calculator locally as the user
 * adjusts sliders (sell price, freight, demurrage, target margin).
 */
export async function composeDealEconomics(
  input: ComposeDealInput,
  defaults: CompanyDealDefaults = {},
): Promise<ComposeDealResult> {
  // Fold company-level defaults into the input first so downstream
  // logic doesn't need to know about the defaults source.
  const merged: ComposeDealInput = {
    ...input,
    sourcingRegion:
      input.sourcingRegion ?? defaults.defaultSourcingRegion ?? undefined,
    monthlyFixedOverheadUsd:
      input.monthlyFixedOverheadUsd ??
      defaults.monthlyFixedOverheadUsdDefault ??
      undefined,
  };
  input = merged;

  // Density resolution: explicit input wins; otherwise look up the
  // most recent producer assay matching `cargoCrudeName`; otherwise
  // fall through to the per-product default. The lookup is a single
  // SQL query — no-op when cargoCrudeName is unset.
  let densitySource: ComposeDealResult['densitySource'] = null;
  let density = input.densityKgL;
  if (density == null && input.cargoCrudeName) {
    const hit = await getDensityForCrudeName(input.cargoCrudeName);
    if (hit) {
      density = hit.densityKgL;
      densitySource = hit;
    }
  }
  if (density == null) density = defaultDensityFor(input.product);

  // Single upfront validation pass — gather every missing-required
  // problem and surface them in one error rather than failing one
  // field at a time. The previous shape forced the LLM to retry up
  // to 3× before getting a runnable input; that's wasteful and
  // user-visible (visible in the Senegal RFQ trace where the model
  // hit volume → sellPrice → productCost errors sequentially).
  const missing: string[] = [];
  const hasVolume =
    (input.volumeUsg != null && input.volumeUsg > 0) ||
    (input.volumeBbls != null && input.volumeBbls > 0) ||
    (input.volumeMt != null && input.volumeMt > 0);
  if (!hasVolume) missing.push('volumeUsg | volumeBbls | volumeMt');
  const hasSellPrice =
    input.sellPricePerUsg != null || input.sellPricePerBbl != null;
  if (!hasSellPrice) missing.push('sellPricePerUsg | sellPricePerBbl');
  if (missing.length > 0) {
    throw new Error(
      `Missing required input(s): ${missing.join(' AND ')}. ` +
        `Volume accepts USG, bbls, or MT; sell price accepts USG or bbls.`,
    );
  }

  const volumeUsg = resolveVolumeUsg(input, density);
  const sellPricePerUsg = resolveSellPricePerUsg(input);

  let benchmark: ComposeDealResult['benchmark'] = null;
  let productCostPerUsg = resolveProductCostPerUsg(input);
  // Track whether productCost came from the caller — used by the
  // wash-sale guard below to distinguish "user explicitly chose to
  // model a wash" from "the calculator auto-defaulted both sides to
  // spot and produced nonsense."
  const productCostUserSupplied = productCostPerUsg != null;
  const asOf = input.asOf ?? new Date().toISOString().slice(0, 10);
  // Non-USGC origins should price off Brent + crack rather than NYH
  // spot — see `sourcingRegion` doc in ComposeDealInput.
  const useBrentCrack =
    productCostPerUsg == null &&
    input.sourcingRegion != null &&
    input.sourcingRegion !== 'usgc' &&
    CRACK_SPREAD_MID_USD_BBL[input.product] != null;

  if (productCostPerUsg == null && useBrentCrack) {
    const brent = await getCommodityPriceContext('brent', 30);
    const brentSpot = brent.latest?.price ?? null;
    const crackMid = CRACK_SPREAD_MID_USD_BBL[input.product]!;
    if (brentSpot != null) {
      const fobPerBbl = brentSpot + crackMid;
      const fobPerUsg = fobPerBbl / USG_PER_BBL;
      benchmark = {
        slug: `brent+crack(${input.product})`,
        asOf: brent.latest!.date,
        pricePerUsg: fobPerUsg,
        pricePerBbl: fobPerBbl,
        usedAsProductCost: true,
      };
      productCostPerUsg = fobPerUsg;
    }
    // If Brent isn't ingested, fall through to the NYH path below.
  }

  if (productCostPerUsg == null) {
    const bm = await getBenchmarkPrice(db, input.product, asOf);
    if (bm) {
      // The `nyh-*` series are literally NY Harbor; for USGC-origin
      // cargoes we shift to the typical USGC basis to avoid a
      // 5-15¢/USG cost overstatement. See USGC_VS_NYH_BASIS_USG.
      const usgcAdj =
        input.sourcingRegion === 'usgc' ? USGC_VS_NYH_BASIS_USG[input.product] : null;
      const adjustedPerUsg = usgcAdj != null ? bm.pricePerUsg + usgcAdj : bm.pricePerUsg;
      const adjustedPerBbl = adjustedPerUsg * USG_PER_BBL;
      benchmark = {
        slug: usgcAdj != null ? `${bm.benchmark.slug}+usgc-basis` : bm.benchmark.slug,
        asOf: bm.asOf,
        pricePerUsg: adjustedPerUsg,
        pricePerBbl: adjustedPerBbl,
        usedAsProductCost: true,
      };
      productCostPerUsg = adjustedPerUsg;
    } else {
      throw new Error(
        `No benchmark price available for product='${input.product}' on or before ${asOf}; ` +
          `pass productCostPerUsg or productCostPerBbl explicitly.`,
      );
    }
  } else if (benchmark == null) {
    // Either an explicit productCost was supplied, or the Brent+crack
    // path was skipped — pull the NYH benchmark as "vs spot" context
    // for the renderer.
    const bm = await getBenchmarkPrice(db, input.product, asOf);
    if (bm) {
      benchmark = {
        slug: bm.benchmark.slug,
        asOf: bm.asOf,
        pricePerUsg: bm.pricePerUsg,
        pricePerBbl: bm.pricePerBbl,
        usedAsProductCost: false,
      };
    }
  }

  // Wash-sale guard. If the caller didn't supply productCost AND the
  // calculator auto-defaulted it to the spot benchmark (or Brent +
  // crack), AND the supplied sellPrice is within 0.01¢/USG of that
  // auto-defaulted cost, refuse the call. Reason: every chat trace
  // that hit this combo produced a "do_not_proceed scorecard 12/100"
  // for what was actually a wash sale — the model anchored sellPrice
  // on the same NYH spot it was about to pull as cost, and the
  // operator saw a guaranteed-loss "deal" instead of a clear "your
  // inputs describe nothing." The fix is to refuse upfront and tell
  // the model exactly which input is missing (sell anchor or supplier
  // FOB).
  //
  // Tolerance is intentionally tight (0.0001 = 0.01¢/USG) so that
  // sellPrice values that COINCIDENTALLY land near the spot benchmark
  // — e.g. the realistic CIF mid for gasoline-super at Caribbean
  // delivery, where Brent + typical crack + freight resolves to
  // ~NYH spot for that product — don't trigger a false positive.
  // Only literal-equal-to-spot calls trip this guard.
  //
  // Bypass via allowWashSale: true when the caller explicitly wants
  // to model the freight/insurance drag on a zero-margin hypothetical.
  if (
    !productCostUserSupplied &&
    !input.allowWashSale &&
    productCostPerUsg != null &&
    Math.abs(sellPricePerUsg - productCostPerUsg) < 0.0001
  ) {
    const benchmarkSlug = benchmark?.slug ?? 'spot';
    const sellBbl = sellPricePerUsg * USG_PER_BBL;
    throw new Error(
      `Wash sale: sellPricePerUsg ($${sellPricePerUsg.toFixed(4)}/USG, ` +
        `$${sellBbl.toFixed(2)}/bbl) equals the auto-defaulted product cost ` +
        `from ${benchmarkSlug} within 0.01¢/USG. That's not a deal — after ` +
        `freight + insurance it goes negative by construction. ` +
        `To model a real deal: pass productCostPerUsg (or productCostPerBbl) ` +
        `with a real supplier FOB, OR pass sellPrice as the realistic CIF ` +
        `mid from evaluate_multi_product_rfq (returns realisticCifUsdPerMt.mid ` +
        `for the destination). To model the wash explicitly, set ` +
        `allowWashSale: true.`,
    );
  }

  // Top-level guard: if the sell price is below the resolved product
  // cost, the deal cannot be profitable at any scale or freight rate.
  // Surface this at the top of the result so the model leads with it
  // instead of presenting a -$36M EBITDA as part of "the plan." The
  // calculator still runs and emits its own critical warning, but
  // having a non-null `topLevelWarning` is the cleaner signal for
  // chat-side rendering and system-prompt discipline.
  let topLevelWarning: string | null = null;
  if (sellPricePerUsg < productCostPerUsg) {
    const sellBbl = sellPricePerUsg * USG_PER_BBL;
    const costBbl = productCostPerUsg * USG_PER_BBL;
    const gap = ((sellPricePerUsg - productCostPerUsg) / productCostPerUsg) * 100;
    topLevelWarning =
      `Sell price ($${sellBbl.toFixed(2)}/bbl) is below product cost ` +
      `($${costBbl.toFixed(2)}/bbl${
        benchmark?.usedAsProductCost ? ` — auto-pulled from ${benchmark.slug}` : ''
      }) by ${gap.toFixed(1)}%. This deal cannot be profitable at any volume/freight ` +
      `assumption. Either raise the sell price, provide a lower productCostPerBbl ` +
      `(e.g. a supplier FOB quote below benchmark), or drop this line.`;
  }

  const inputs = buildFuelDealInputs({
    input,
    volumeUsg,
    densityKgL: density,
    sellPricePerUsg,
    productCostPerUsg,
    defaults,
  });
  const results = calculateFuelDeal(inputs);

  // Second top-level guard: even when sell > cost, freight + insurance
  // + min-margin requirement can push the fully-loaded CIF above the
  // sell price. The calculator catches this with scorecard
  // recommendation='do_not_proceed' + a critical warning, but those
  // get buried in `results.scorecard.*` and `results.warnings[]`.
  // Surface at top level so renderers and system-prompt discipline
  // can lead with it.
  if (topLevelWarning == null && results.scorecard.recommendation === 'do_not_proceed') {
    topLevelWarning =
      `${results.scorecard.recommendationReason}. Scorecard ${results.scorecard.overallScore.toFixed(0)}/100. ` +
      `Breakeven sell ${results.breakeven.sellPricePerUsg.toFixed(4)}/USG ` +
      `($${(results.breakeven.sellPricePerUsg * USG_PER_BBL).toFixed(2)}/bbl) ` +
      `vs your ${sellPricePerUsg.toFixed(4)}/USG. Lift sell price, tighten freight, ` +
      `or get a lower supplier cost before treating this line as viable.`;
  }

  return { inputs, results, benchmark, topLevelWarning, densitySource, kind: 'deal_economics' };
}

function resolveVolumeUsg(input: ComposeDealInput, densityKgL: number): number {
  if (input.volumeUsg != null && input.volumeUsg > 0) return input.volumeUsg;
  if (input.volumeBbls != null && input.volumeBbls > 0) {
    return input.volumeBbls * USG_PER_BBL;
  }
  if (input.volumeMt != null && input.volumeMt > 0) {
    return input.volumeMt * usgPerMt(densityKgL);
  }
  // Validation upfront should prevent reaching here, but throw for safety.
  throw new Error('Volume required.');
}

function resolveSellPricePerUsg(input: ComposeDealInput): number {
  if (input.sellPricePerUsg != null) return input.sellPricePerUsg;
  if (input.sellPricePerBbl != null) return input.sellPricePerBbl / USG_PER_BBL;
  throw new Error('Sell price required.');
}

function resolveProductCostPerUsg(input: ComposeDealInput): number | null {
  if (input.productCostPerUsg != null) return input.productCostPerUsg;
  if (input.productCostPerBbl != null) return input.productCostPerBbl / USG_PER_BBL;
  return null;
}

function buildFuelDealInputs(args: {
  input: ComposeDealInput;
  volumeUsg: number;
  densityKgL: number;
  sellPricePerUsg: number;
  productCostPerUsg: number;
  defaults: CompanyDealDefaults;
}): FuelDealInputs {
  const {
    input,
    volumeUsg,
    densityKgL,
    sellPricePerUsg,
    productCostPerUsg,
    defaults,
  } = args;
  const freightPerUsg = input.freightPerUsg ?? 0;
  const minGrossMarginPct = defaults.targetGrossMarginPct ?? 0.04;
  const minNetMarginPerUsg = defaults.targetNetMarginPerUsg ?? 0.02;
  const inputs: FuelDealInputs = {
    dealRef: input.dealRef ?? `deal-${Date.now()}`,
    product: input.product,
    incoterm: input.incoterm ?? 'cfr',
    volumeUsg,
    densityKgL,
    volumeTolerancePct: 0.02,
    sellPricePerUsg,
    buyerCurrencyCode: 'usd',
    fxRateToUsd: 1,
    productCostPerUsg,
    productQualityPremiumPerUsg: 0,
    freightPerUsg,
    cargoInsurancePct: 0.002,
    warRiskPremiumPct: 0,
    politicalRiskPremiumPct: 0,
    dischargeHandlingPerUsg: input.dischargeHandlingPerUsg ?? 0,
    compliancePerUsg: input.compliancePerUsg ?? 0,
    tradeFinancePerUsg: input.tradeFinancePerUsg ?? 0,
    intermediaryFeePerUsg: input.intermediaryFeePerUsg ?? 0,
    vtcVariableOpsPerUsg: input.vtcVariableOpsPerUsg ?? 0,
    overheadAllocationUsd: 0,
    tradeFinance: { type: 'lc_sight' },
    counterpartyRiskScore: input.counterpartyRiskScore ?? 50,
    countryRiskScore: input.countryRiskScore ?? 50,
    thresholds: {
      maxPeakCashExposureUsd: 10_000_000,
      minGrossMarginPct,
      minNetMarginPerUsg,
      maxCounterpartyRiskScore: 70,
      maxCountryRiskScore: 75,
      maxDemurrageDays: 5,
    },
    monthlyFixedOverheadUsd: input.monthlyFixedOverheadUsd ?? 0,
  };
  if (input.freightRateUsdPerMt != null) {
    inputs.freightRateUsdPerMt = input.freightRateUsdPerMt;
  }
  if (input.demurrageDays != null && input.demurrageRatePerDay != null) {
    inputs.vessel = {
      capacityUsg: volumeUsg,
      utilizationPct: 0.95,
      freightLumpSumUsd: 0,
      demurrageRatePerDay: input.demurrageRatePerDay,
      demurrageEstimatedDays: input.demurrageDays,
      despatchRatePerDay: 0,
      portDuesLoadUsd: 0,
      portDuesDischargeUsd: 0,
      canalTransitUsd: 0,
    };
  }
  return inputs;
}

/**
 * Per-product density defaults (kg/L). Sourced from typical refining
 * datasheets — close enough for back-of-envelope economics. The
 * caller can always override via `densityKgL`.
 */
function defaultDensityFor(product: ProductType): number {
  switch (product) {
    case 'ulsd':
      return 0.84;
    case 'gasoline_87':
      return 0.74;
    case 'gasoline_91':
      return 0.745;
    case 'jet_a':
    case 'jet_a1':
      return 0.81;
    case 'kerosene':
      // Kerosene tracks jet density closely (same middle distillate cut,
      // jet is essentially kerosene with additives).
      return 0.81;
    case 'avgas':
      return 0.71;
    case 'lfo':
      return 0.86;
    case 'hfo':
      return 0.96;
    case 'lng':
      return 0.45;
    case 'lpg':
      return 0.55;
    case 'biodiesel_b20':
      return 0.85;
    // Crude bands — typical mid-band density for each API class.
    // Light sweet (Es Sider, Brent, Bonny Light): 32-42° API → ~0.835
    // Medium sour (Arab Light, Mars, Urals): 28-32° API → ~0.870
    // Heavy (WCS, Maya, Cold Lake): < 22° API → ~0.920
    // Per-deal density override remains the right move when the user
    // has a specific assay; these are sane defaults for back-of-
    // envelope crude P&Ls.
    case 'crude_light_sweet':
      return 0.835;
    case 'crude_medium_sour':
      return 0.87;
    case 'crude_heavy':
      return 0.92;
    default:
      return 0.85;
  }
}
