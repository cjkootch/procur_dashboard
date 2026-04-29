import { NextResponse } from 'next/server';
import { z } from 'zod';
import { evaluateOfferAgainstHistory } from '@procur/catalog';
import { verifyIntelligenceToken } from '../../../../lib/intelligence-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/intelligence/evaluate-offer
 *
 * Body:
 *   { category_tag, grade?, buyer_country, offered_price_usd,
 *     offered_price_unit: "USD/L"|"USD/gal"|"USD/bbl"|"USD/MT",
 *     evaluation_date? }
 *
 * Response (vex's exact shape):
 *   { benchmarkCode, benchmarkSpotUsd, effectiveBenchmarkUsd,
 *     offerDeltaUsd, offerDeltaPct,
 *     historicalMeanDeltaPct, historicalMedianDeltaPct,
 *     historicalStddevDeltaPct, historicalSampleSize,
 *     zScore, percentile,
 *     verdict: "aggressive"|"competitive"|"fair"|"high"|"outlier_high",
 *     rationale }
 *
 * Unit conversion: our internal `evaluateOfferAgainstHistory` works
 * exclusively in USD/bbl. We convert vex's units up front, run
 * the analysis, then map the verdict thresholds.
 *
 * `grade` and `evaluation_date` are accepted for forward-compat but
 * not yet used — the underlying query uses today's spot regardless.
 */
const BodySchema = z.object({
  category_tag: z.string().min(1),
  grade: z.string().nullable().optional(),
  buyer_country: z.string().length(2),
  offered_price_usd: z.number().positive(),
  offered_price_unit: z.enum(['USD/L', 'USD/gal', 'USD/bbl', 'USD/MT']),
  evaluation_date: z.string().nullable().optional(),
});

const USG_PER_BBL = 42;
const LITRES_PER_BBL = 158.987;
// Approximate density-derived MT→bbl conversion. Caller's price-per-MT
// gets divided by this to get USD/bbl. Tuned per category. For grades
// we don't list, the caller should switch to USD/L or USD/bbl.
const MT_PER_BBL_BY_CATEGORY: Record<string, number> = {
  'crude-oil': 7.33, // light-sweet ~7.33 bbl/MT (Brent-class)
  'diesel': 7.46,
  'gasoline': 8.5,
  'jet-fuel': 7.91,
  'heating-oil': 7.46,
};

function convertToUsdPerBbl(args: {
  pricePerUnit: number;
  unit: 'USD/L' | 'USD/gal' | 'USD/bbl' | 'USD/MT';
  categoryTag: string;
}): { value: number; conversionNote: string } {
  switch (args.unit) {
    case 'USD/bbl':
      return { value: args.pricePerUnit, conversionNote: 'native USD/bbl' };
    case 'USD/gal':
      return {
        value: args.pricePerUnit * USG_PER_BBL,
        conversionNote: `USD/gal × ${USG_PER_BBL} = USD/bbl`,
      };
    case 'USD/L':
      return {
        value: args.pricePerUnit * LITRES_PER_BBL,
        conversionNote: `USD/L × ${LITRES_PER_BBL} = USD/bbl`,
      };
    case 'USD/MT': {
      const bblPerMt = MT_PER_BBL_BY_CATEGORY[args.categoryTag] ?? 7.33;
      return {
        value: args.pricePerUnit / bblPerMt,
        conversionNote: `USD/MT ÷ ${bblPerMt} (${args.categoryTag}) = USD/bbl`,
      };
    }
  }
}

/**
 * Map our internal verdict into vex's 5-bucket scale based on the
 * z-score + delta direction.
 *
 * Z-score thresholds (1-tailed):
 *   z ≤ -1.5         : "aggressive"      (well below buyer-pool average)
 *   -1.5 < z ≤ -0.5  : "competitive"     (meaningfully below)
 *   -0.5 < z ≤  0.5  : "fair"            (near the empirical mean)
 *    0.5 < z ≤  1.5  : "high"            (meaningfully above)
 *    z >  1.5        : "outlier_high"    (extreme; suggests bad deal or stale data)
 *
 * When zScore is null (no benchmark or no history), we fall back
 * to the categorical verdict from the underlying query.
 */
function mapVerdict(
  zScore: number | null,
  internalVerdict: string,
): 'aggressive' | 'competitive' | 'fair' | 'high' | 'outlier_high' {
  if (zScore == null) {
    if (internalVerdict === 'below-band') return 'competitive';
    if (internalVerdict === 'above-band') return 'high';
    return 'fair';
  }
  if (zScore <= -1.5) return 'aggressive';
  if (zScore <= -0.5) return 'competitive';
  if (zScore <= 0.5) return 'fair';
  if (zScore <= 1.5) return 'high';
  return 'outlier_high';
}

/**
 * Approximate the percentile from a z-score using the standard
 * normal CDF. Good enough for vex's UI binning; not statistically
 * rigorous (real distributions have fatter tails). Uses
 * Abramowitz & Stegun's Φ(z) approximation.
 */
function zScoreToPercentile(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804 * Math.exp(-(z * z) / 2);
  const p =
    d *
    t *
    (0.31938153 +
      t *
        (-0.356563782 +
          t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return z >= 0 ? Math.round((1 - p) * 100) : Math.round(p * 100);
}

export async function POST(req: Request): Promise<Response> {
  const auth = verifyIntelligenceToken(req);
  if (auth) return auth;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }
  const parsed = BodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'bad_request', detail: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const input = parsed.data;

  const { value: offerPriceUsdPerBbl, conversionNote } = convertToUsdPerBbl({
    pricePerUnit: input.offered_price_usd,
    unit: input.offered_price_unit,
    categoryTag: input.category_tag,
  });

  const result = await evaluateOfferAgainstHistory({
    buyerCountry: input.buyer_country,
    categoryTag: input.category_tag,
    offerPriceUsdPerBbl,
  });

  const verdict = mapVerdict(result.zScore, result.verdict);
  const percentile = result.zScore != null ? zScoreToPercentile(result.zScore) : null;

  const offerDeltaUsd =
    result.benchmarkSpotUsdPerBbl != null
      ? offerPriceUsdPerBbl - result.benchmarkSpotUsdPerBbl
      : null;
  const offerDeltaPct =
    result.benchmarkSpotUsdPerBbl != null && result.benchmarkSpotUsdPerBbl > 0
      ? ((offerPriceUsdPerBbl - result.benchmarkSpotUsdPerBbl) /
          result.benchmarkSpotUsdPerBbl) *
        100
      : null;

  const rationale = composeRationale({
    verdict,
    zScore: result.zScore,
    sampleSize: result.historyAwardCount,
    benchmarkSlug: result.benchmarkSlug,
    conversionNote,
  });

  return NextResponse.json({
    benchmarkCode: result.benchmarkSlug,
    benchmarkSpotUsd: result.benchmarkSpotUsdPerBbl,
    effectiveBenchmarkUsd: result.expectedPriceUsdPerBbl,
    offerDeltaUsd,
    offerDeltaPct,
    // Our query returns expected (predicted) deltas; treat those as
    // the historical mean. Median + stddev would require a second
    // pass through the MV — surfaced as null for now.
    historicalMeanDeltaPct:
      result.expectedDeltaUsdPerBbl != null && result.benchmarkSpotUsdPerBbl != null
        ? (result.expectedDeltaUsdPerBbl / result.benchmarkSpotUsdPerBbl) * 100
        : null,
    historicalMedianDeltaPct: null,
    historicalStddevDeltaPct: null,
    historicalSampleSize: result.historyAwardCount,
    zScore: result.zScore,
    percentile,
    verdict,
    rationale,
  });
}

function composeRationale(args: {
  verdict: string;
  zScore: number | null;
  sampleSize: number;
  benchmarkSlug: string | null;
  conversionNote: string;
}): string {
  if (args.benchmarkSlug == null) {
    return `No spot benchmark available for this category × country. ${args.conversionNote}.`;
  }
  if (args.sampleSize === 0) {
    return `No historical buyer-pool data for this country × category. Verdict reflects spot-band position only. Benchmark: ${args.benchmarkSlug}. ${args.conversionNote}.`;
  }
  const z = args.zScore != null ? args.zScore.toFixed(2) : 'n/a';
  return `${args.verdict.replace(/_/g, ' ')} vs the ${args.sampleSize}-award buyer-pool history (z=${z}). Benchmark: ${args.benchmarkSlug}. ${args.conversionNote}.`;
}
