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

/**
 * LLM-friendly input shape for `compose_deal_economics`. A small subset of
 * the calculator's full `FuelDealInputs` — the rest are filled by sensible
 * defaults so the assistant only has to provide what the user actually
 * mentioned (typical: product, volume, sell price, product cost, freight).
 */
export type ComposeDealInput = {
  product: ProductType;
  /** Provide volumeUsg OR volumeBbls. */
  volumeUsg?: number;
  volumeBbls?: number;
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
  /** Tells the client renderer this is a deal-economics output. */
  kind: 'deal_economics';
};

/**
 * Build a fully-populated FuelDealInputs from a sparse user-facing
 * input record, then run the calculator and return both the resolved
 * inputs and the results. The resolved inputs are echoed back so the
 * client renderer can re-run the calculator locally as the user
 * adjusts sliders (sell price, freight, demurrage, target margin).
 */
export async function composeDealEconomics(
  input: ComposeDealInput,
): Promise<ComposeDealResult> {
  const density = input.densityKgL ?? defaultDensityFor(input.product);
  const volumeUsg = resolveVolumeUsg(input);
  const sellPricePerUsg = resolveSellPricePerUsg(input);

  let benchmark: ComposeDealResult['benchmark'] = null;
  let productCostPerUsg = resolveProductCostPerUsg(input);
  if (productCostPerUsg == null) {
    const asOf = input.asOf ?? new Date().toISOString().slice(0, 10);
    const bm = await getBenchmarkPrice(db, input.product, asOf);
    if (bm) {
      benchmark = {
        slug: bm.benchmark.slug,
        asOf: bm.asOf,
        pricePerUsg: bm.pricePerUsg,
        pricePerBbl: bm.pricePerBbl,
        usedAsProductCost: true,
      };
      productCostPerUsg = bm.pricePerUsg;
    } else {
      throw new Error(
        `No benchmark price available for product='${input.product}' on or before ${asOf}; ` +
          `pass productCostPerUsg or productCostPerBbl explicitly.`,
      );
    }
  } else {
    // Benchmark still useful for the renderer to show "vs spot" context.
    const asOf = input.asOf ?? new Date().toISOString().slice(0, 10);
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

  const inputs = buildFuelDealInputs({
    input,
    volumeUsg,
    densityKgL: density,
    sellPricePerUsg,
    productCostPerUsg,
  });
  const results = calculateFuelDeal(inputs);
  return { inputs, results, benchmark, kind: 'deal_economics' };
}

function resolveVolumeUsg(input: ComposeDealInput): number {
  if (input.volumeUsg != null && input.volumeUsg > 0) return input.volumeUsg;
  if (input.volumeBbls != null && input.volumeBbls > 0) {
    return input.volumeBbls * USG_PER_BBL;
  }
  throw new Error('Either volumeUsg or volumeBbls must be provided.');
}

function resolveSellPricePerUsg(input: ComposeDealInput): number {
  if (input.sellPricePerUsg != null) return input.sellPricePerUsg;
  if (input.sellPricePerBbl != null) return input.sellPricePerBbl / USG_PER_BBL;
  throw new Error('Either sellPricePerUsg or sellPricePerBbl must be provided.');
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
}): FuelDealInputs {
  const { input, volumeUsg, densityKgL, sellPricePerUsg, productCostPerUsg } = args;
  const freightPerUsg = input.freightPerUsg ?? 0;
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
      minGrossMarginPct: 0.04,
      minNetMarginPerUsg: 0.02,
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
    default:
      return 0.85;
  }
}
