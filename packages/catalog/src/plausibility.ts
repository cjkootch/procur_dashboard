/**
 * Target-price plausibility analysis. Given a buyer's "we want
 * Product X at $Y/MT CIF Port Z" target, compute what a realistic
 * CIF range looks like (live spot benchmark + typical crack spread
 * + freight to the delivery port + a small seller margin) and
 * surface the gap.
 *
 * Two verdicts come out the back: a numeric `pctGap` (negative =
 * target below realistic) and a categorical `verdict` that maps to
 * a short narrative the assistant can echo.
 *
 * Designed around the 2026-Q2 Senegal-style West Africa RFQ trace:
 * EN590 @ $430/MT CIF, gasoline @ $440/MT CIF, jet @ $78/bbl —
 * those numbers are ~30-50% below realistic delivery cost. Without
 * this check, the assistant has to either run pricing math by hand
 * (slow + error-prone) or take the user's "is this competitive"
 * question at face value.
 */
import { getCommodityPriceContext } from './queries';
import {
  lookupFreightEstimate,
  type FreightOriginRegion,
  type FreightProductType,
} from './freight-routes';

export type ProductSlug =
  | 'en590-ulsd'
  | 'gasoline-super'
  | 'jet-a1'
  | 'kerosene'
  | 'gasoil-0.5pct' // legacy bunker / low-sulfur gasoil
  | 'hsfo'
  | 'crude-light-sweet' // Brent-spec generic
  | 'crude-medium-sour'; // Dubai-spec generic

/**
 * MT → bbl conversion by product. Source: published density tables
 * (Argus / Platts methodology). Approximate; real cargoes vary by
 * temperature.
 */
const BBL_PER_MT: Record<ProductSlug, number> = {
  'en590-ulsd': 7.46,
  'gasoline-super': 8.45,
  'jet-a1': 7.94,
  kerosene: 7.93,
  'gasoil-0.5pct': 7.45,
  hsfo: 6.35,
  'crude-light-sweet': 7.30,
  'crude-medium-sour': 7.10,
};

/**
 * Typical crack spread bands in USD/bbl over Brent. Where a direct
 * NYH benchmark exists in `commodity_prices` we'll use that when
 * available; this is the fallback. Bands are chosen to cover the
 * normal-week range, not extremes.
 */
const CRACK_SPREAD_USD_BBL: Record<ProductSlug, { low: number; high: number }> = {
  'en590-ulsd': { low: 15, high: 22 },
  'gasoline-super': { low: 10, high: 18 },
  'jet-a1': { low: 18, high: 25 },
  kerosene: { low: 15, high: 22 },
  'gasoil-0.5pct': { low: 10, high: 18 },
  hsfo: { low: -10, high: -3 }, // residual fuel trades AT a discount
  'crude-light-sweet': { low: 0, high: 0 },
  'crude-medium-sour': { low: -5, high: -2 },
};

const BENCHMARK_SLUG: Record<ProductSlug, string> = {
  'en590-ulsd': 'brent',
  'gasoline-super': 'brent',
  'jet-a1': 'brent',
  kerosene: 'brent',
  'gasoil-0.5pct': 'brent',
  hsfo: 'brent',
  'crude-light-sweet': 'brent',
  'crude-medium-sour': 'dubai',
};

export type EvaluateTargetPriceInput = {
  product: ProductSlug;
  /** Either targetCifUsdPerMt OR targetCifUsdPerBbl is required. */
  targetCifUsdPerMt?: number;
  targetCifUsdPerBbl?: number;
  /** Port slug as seeded in `ports` (e.g. 'lome-port'). */
  destPortSlug: string;
  /** Most likely sourcing region. If omitted, the cheapest matching
      route across all origins is used. */
  originRegion?: FreightOriginRegion;
  /** Optional volume hint — used only for descriptive output. */
  volumeMt?: number;
};

export type Verdict =
  | 'overpriced' // > +10% above realistic (buyer leaving margin on the table)
  | 'plausible' // -5% to +10% (within seller margin)
  | 'aggressive' // -15% to -5% (tight; would need lean cost structure)
  | 'unrealistic' // -30% to -15% (no sustainable refiner can hit this)
  | 'scam-flag'; // < -30% below (broker-chain anchor or fraud pattern)

export type EvaluateTargetPriceResult = {
  product: ProductSlug;
  destPortSlug: string;
  bblPerMt: number;
  targetCifUsdPerMt: number;
  targetCifUsdPerBbl: number;
  benchmarkSlug: string;
  benchmarkSpotUsdPerBbl: number | null;
  benchmarkAsOf: string | null;
  crackSpreadLow: number;
  crackSpreadHigh: number;
  freight: {
    originRegion: FreightOriginRegion | null;
    vesselClassTypical: string | null;
    usdPerMtLow: number | null;
    usdPerMtHigh: number | null;
    routesConsidered: number;
  };
  realisticCifUsdPerMt: { low: number; mid: number; high: number } | null;
  realisticCifUsdPerBbl: { low: number; mid: number; high: number } | null;
  pctGapVsMid: number | null;
  verdict: Verdict | 'no-data';
  narrative: string;
};

function classify(pctGap: number): Verdict {
  if (pctGap > 0.10) return 'overpriced';
  if (pctGap >= -0.05) return 'plausible';
  if (pctGap >= -0.15) return 'aggressive';
  if (pctGap >= -0.30) return 'unrealistic';
  return 'scam-flag';
}

export async function evaluateTargetPrice(
  input: EvaluateTargetPriceInput,
): Promise<EvaluateTargetPriceResult> {
  const bblPerMt = BBL_PER_MT[input.product];
  if (!bblPerMt) throw new Error(`unknown product: ${input.product}`);

  const targetUsdPerMt =
    input.targetCifUsdPerMt ??
    (input.targetCifUsdPerBbl != null
      ? input.targetCifUsdPerBbl * bblPerMt
      : NaN);
  if (!Number.isFinite(targetUsdPerMt)) {
    throw new Error('targetCifUsdPerMt or targetCifUsdPerBbl is required');
  }
  const targetUsdPerBbl = targetUsdPerMt / bblPerMt;

  const benchmarkSlug = BENCHMARK_SLUG[input.product];
  const benchmark = await getCommodityPriceContext(benchmarkSlug, 30);
  const benchmarkSpot = benchmark.latest?.price ?? null;
  const benchmarkAsOf = benchmark.latest?.date ?? null;

  const crack = CRACK_SPREAD_USD_BBL[input.product];

  // Freight: pick all matching routes, then take the min low + min
  // high if originRegion was unspecified (cheapest sourcing); else
  // restrict to the requested origin.
  const candidateRoutes = lookupFreightEstimate({
    destPortSlug: input.destPortSlug,
    originRegion: input.originRegion,
    productType: (input.product.startsWith('crude-')
      ? 'crude'
      : 'clean') as FreightProductType,
  });

  let freightLow: number | null = null;
  let freightHigh: number | null = null;
  let chosenOrigin: FreightOriginRegion | null = input.originRegion ?? null;
  let chosenVessel: string | null = null;

  if (candidateRoutes.length > 0) {
    if (input.originRegion) {
      const r = candidateRoutes[0]!;
      freightLow = r.usdPerMtLow;
      freightHigh = r.usdPerMtHigh;
      chosenOrigin = r.originRegion;
      chosenVessel = r.vesselClassTypical;
    } else {
      // Cheapest sourcing: minimum low and minimum high across origins.
      const cheapest = [...candidateRoutes].sort(
        (a, b) => a.usdPerMtLow - b.usdPerMtLow,
      )[0]!;
      freightLow = cheapest.usdPerMtLow;
      freightHigh = cheapest.usdPerMtHigh;
      chosenOrigin = cheapest.originRegion;
      chosenVessel = cheapest.vesselClassTypical;
    }
  }

  // Realistic CIF = (Brent + crack) per bbl, then × MT-conversion, plus freight per MT.
  // Use a small ($5/MT) seller margin band on top.
  const SELLER_MARGIN_USD_PER_MT = { low: 3, high: 8 };

  let realisticPerMt: { low: number; mid: number; high: number } | null = null;
  let realisticPerBbl: { low: number; mid: number; high: number } | null = null;
  let pctGap: number | null = null;
  let verdict: Verdict | 'no-data' = 'no-data';

  if (benchmarkSpot != null && freightLow != null && freightHigh != null) {
    const fobLowPerBbl = benchmarkSpot + crack.low;
    const fobHighPerBbl = benchmarkSpot + crack.high;
    const cifLowPerMt =
      fobLowPerBbl * bblPerMt + freightLow + SELLER_MARGIN_USD_PER_MT.low;
    const cifHighPerMt =
      fobHighPerBbl * bblPerMt + freightHigh + SELLER_MARGIN_USD_PER_MT.high;
    const cifMidPerMt = (cifLowPerMt + cifHighPerMt) / 2;
    realisticPerMt = { low: cifLowPerMt, mid: cifMidPerMt, high: cifHighPerMt };
    realisticPerBbl = {
      low: cifLowPerMt / bblPerMt,
      mid: cifMidPerMt / bblPerMt,
      high: cifHighPerMt / bblPerMt,
    };
    pctGap = (targetUsdPerMt - cifMidPerMt) / cifMidPerMt;
    verdict = classify(pctGap);
  }

  const narrative = buildNarrative({
    input,
    targetUsdPerMt,
    targetUsdPerBbl,
    benchmarkSpot,
    benchmarkSlug,
    realisticPerMt,
    pctGap,
    verdict,
    freightOrigin: chosenOrigin,
    routesCount: candidateRoutes.length,
  });

  return {
    product: input.product,
    destPortSlug: input.destPortSlug,
    bblPerMt,
    targetCifUsdPerMt: targetUsdPerMt,
    targetCifUsdPerBbl: targetUsdPerBbl,
    benchmarkSlug,
    benchmarkSpotUsdPerBbl: benchmarkSpot,
    benchmarkAsOf,
    crackSpreadLow: crack.low,
    crackSpreadHigh: crack.high,
    freight: {
      originRegion: chosenOrigin,
      vesselClassTypical: chosenVessel,
      usdPerMtLow: freightLow,
      usdPerMtHigh: freightHigh,
      routesConsidered: candidateRoutes.length,
    },
    realisticCifUsdPerMt: realisticPerMt,
    realisticCifUsdPerBbl: realisticPerBbl,
    pctGapVsMid: pctGap,
    verdict,
    narrative,
  };
}

function buildNarrative(args: {
  input: EvaluateTargetPriceInput;
  targetUsdPerMt: number;
  targetUsdPerBbl: number;
  benchmarkSpot: number | null;
  benchmarkSlug: string;
  realisticPerMt: { low: number; mid: number; high: number } | null;
  pctGap: number | null;
  verdict: Verdict | 'no-data';
  freightOrigin: FreightOriginRegion | null;
  routesCount: number;
}): string {
  if (args.verdict === 'no-data') {
    if (args.benchmarkSpot == null) {
      return `${args.benchmarkSlug} spot benchmark not yet ingested — cannot evaluate plausibility.`;
    }
    if (args.routesCount === 0) {
      return `No freight route in catalog for dest=${args.input.destPortSlug}; cannot quote a realistic CIF range.`;
    }
    return 'Insufficient data.';
  }
  const pct = (args.pctGap! * 100).toFixed(1);
  const r = args.realisticPerMt!;
  const verdictPhrase: Record<Verdict, string> = {
    overpriced: `target sits ${pct}% above realistic mid — buyer is paying premium.`,
    plausible: `target sits ${pct}% from realistic mid — within typical seller margin.`,
    aggressive: `target is ${pct}% below realistic mid — tight but reachable for lean refiners.`,
    unrealistic: `target is ${pct}% below realistic mid — no sustainable refiner or trader hits this CIF.`,
    'scam-flag': `target is ${pct}% below realistic mid — pattern matches broker-chain anchors / RFQ scams. Verify counterparty before quoting.`,
  };
  return `Realistic CIF ${args.input.destPortSlug} ≈ \$${r.low.toFixed(0)}–${r.high.toFixed(0)}/MT (mid ~\$${r.mid.toFixed(0)}); ${verdictPhrase[args.verdict]}`;
}

// ── Multi-product RFQ wrapper ───────────────────────────────────

export type RfqLine = {
  product: ProductSlug;
  volumeMt?: number;
  targetCifUsdPerMt?: number;
  targetCifUsdPerBbl?: number;
  destPortSlug: string;
};

export type EvaluateMultiProductRfqInput = {
  lines: RfqLine[];
  originRegion?: FreightOriginRegion;
};

export type EvaluateMultiProductRfqResult = {
  lines: EvaluateTargetPriceResult[];
  worstVerdict: Verdict | 'no-data';
  weightedAvgPctGap: number | null;
  totalTargetUsd: number;
  totalRealisticUsd: number | null;
  flaggedLineCount: number;
  summary: string;
};

const VERDICT_RANK: Record<Verdict | 'no-data', number> = {
  overpriced: 0,
  plausible: 1,
  'no-data': 2,
  aggressive: 3,
  unrealistic: 4,
  'scam-flag': 5,
};

export async function evaluateMultiProductRfq(
  input: EvaluateMultiProductRfqInput,
): Promise<EvaluateMultiProductRfqResult> {
  const lines = await Promise.all(
    input.lines.map((line) =>
      evaluateTargetPrice({
        product: line.product,
        targetCifUsdPerMt: line.targetCifUsdPerMt,
        targetCifUsdPerBbl: line.targetCifUsdPerBbl,
        destPortSlug: line.destPortSlug,
        originRegion: input.originRegion,
        volumeMt: line.volumeMt,
      }),
    ),
  );

  let worstVerdict: Verdict | 'no-data' = 'plausible';
  let totalTargetUsd = 0;
  let totalRealisticUsd: number | null = 0;
  let weightedGapNumerator = 0;
  let weightedGapDenominator = 0;
  let flaggedLineCount = 0;

  for (let i = 0; i < lines.length; i += 1) {
    const result = lines[i]!;
    const reqLine = input.lines[i]!;
    if (VERDICT_RANK[result.verdict] > VERDICT_RANK[worstVerdict]) {
      worstVerdict = result.verdict;
    }
    if (
      result.verdict === 'unrealistic' ||
      result.verdict === 'scam-flag' ||
      result.verdict === 'aggressive'
    ) {
      flaggedLineCount += 1;
    }
    if (reqLine.volumeMt != null) {
      totalTargetUsd += reqLine.volumeMt * result.targetCifUsdPerMt;
      if (result.realisticCifUsdPerMt != null && totalRealisticUsd != null) {
        totalRealisticUsd += reqLine.volumeMt * result.realisticCifUsdPerMt.mid;
      } else {
        totalRealisticUsd = null;
      }
      if (result.pctGapVsMid != null) {
        weightedGapNumerator += reqLine.volumeMt * result.pctGapVsMid;
        weightedGapDenominator += reqLine.volumeMt;
      }
    }
  }

  const weightedAvgPctGap =
    weightedGapDenominator > 0 ? weightedGapNumerator / weightedGapDenominator : null;

  const summary = buildRfqSummary({
    worstVerdict,
    weightedAvgPctGap,
    totalTargetUsd,
    totalRealisticUsd,
    flaggedLineCount,
    lineCount: lines.length,
  });

  return {
    lines,
    worstVerdict,
    weightedAvgPctGap,
    totalTargetUsd,
    totalRealisticUsd,
    flaggedLineCount,
    summary,
  };
}

function buildRfqSummary(args: {
  worstVerdict: Verdict | 'no-data';
  weightedAvgPctGap: number | null;
  totalTargetUsd: number;
  totalRealisticUsd: number | null;
  flaggedLineCount: number;
  lineCount: number;
}): string {
  const parts: string[] = [];
  if (args.totalTargetUsd > 0) {
    parts.push(
      `RFQ total at buyer's target: \$${(args.totalTargetUsd / 1e6).toFixed(1)}M.`,
    );
  }
  if (args.totalRealisticUsd != null && args.totalRealisticUsd > 0) {
    parts.push(
      `Realistic mid for the same volume: \$${(args.totalRealisticUsd / 1e6).toFixed(1)}M (gap ${
        args.weightedAvgPctGap != null
          ? `${(args.weightedAvgPctGap * 100).toFixed(1)}%`
          : 'unknown'
      }).`,
    );
  }
  if (args.flaggedLineCount > 0) {
    parts.push(
      `${args.flaggedLineCount} of ${args.lineCount} lines below typical seller margin.`,
    );
  }
  parts.push(`Worst-line verdict: ${args.worstVerdict}.`);
  return parts.join(' ');
}
