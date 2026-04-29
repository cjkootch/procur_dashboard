import { NextResponse } from 'next/server';
import { z } from 'zod';
import { findSuppliersForTender } from '@procur/catalog';
import { verifyIntelligenceToken } from '../../../../lib/intelligence-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/intelligence/find-suppliers-for-tender
 *
 * Body (snake_case in, vex contract):
 *   { procur_opportunity_id?, origin_bias?: { lat, lon, weight_factor },
 *     limit? }
 *
 * Optional richer parameters preserved for non-vex callers (chat
 * tools etc.):
 *   { category_tag?, description_keywords?, buyer_country?,
 *     beneficiary_country?, years_lookback? }
 *
 * Response (vex contract):
 *   { candidates: [{supplierEntityId, legalName, country,
 *                   pastTenderWins, avgWinSizeUsd, relevanceScore,
 *                   rationale}], totalCount }
 *
 * relevanceScore is the supplier's matching-awards count normalised
 * to 0–1 across the result set, plus the proximity boost (already
 * 0–weightFactor) when origin_bias is set. rationale joins the
 * matchReasons array from the underlying query.
 */
const BodySchema = z.object({
  procur_opportunity_id: z.string().uuid().optional(),
  category_tag: z.string().optional(),
  description_keywords: z.array(z.string()).optional(),
  buyer_country: z.string().length(2).optional(),
  beneficiary_country: z.string().length(2).optional(),
  years_lookback: z.number().int().min(1).max(20).optional(),
  limit: z.number().int().min(1).max(200).optional(),
  origin_bias: z
    .object({
      lat: z.number().min(-90).max(90),
      lon: z.number().min(-180).max(180),
      weight_factor: z.number().positive().max(50),
    })
    .optional(),
});

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
  const b = parsed.data;

  const result = await findSuppliersForTender(null, {
    opportunityId: b.procur_opportunity_id,
    categoryTag: b.category_tag,
    descriptionKeywords: b.description_keywords,
    buyerCountry: b.buyer_country,
    beneficiaryCountry: b.beneficiary_country,
    yearsLookback: b.years_lookback,
    limit: b.limit,
    originBias: b.origin_bias
      ? { lat: b.origin_bias.lat, lon: b.origin_bias.lon, weightFactor: b.origin_bias.weight_factor }
      : undefined,
  });

  const maxAwards = result.suppliers.reduce(
    (m, s) => Math.max(m, s.matchingAwardsCount),
    1,
  );
  const candidates = result.suppliers.map((s) => {
    const avg =
      s.totalValueUsd != null && s.matchingAwardsCount > 0
        ? s.totalValueUsd / s.matchingAwardsCount
        : null;
    const baseRelevance = s.matchingAwardsCount / maxAwards;
    const relevanceScore = s.proximityBoost != null
      ? baseRelevance + s.proximityBoost / 10 // proximityBoost is 0..weightFactor; scale into the relevance range
      : baseRelevance;
    const rationale = composeRationale(s);
    return {
      supplierEntityId: s.supplierId,
      legalName: s.supplierName,
      country: s.country,
      pastTenderWins: s.matchingAwardsCount,
      avgWinSizeUsd: avg,
      relevanceScore,
      rationale,
    };
  });

  return NextResponse.json({ candidates, totalCount: candidates.length });
}

function composeRationale(s: {
  matchReasons: string[];
  distanceFromBiasNm?: number | null;
  proximityBoost?: number;
}): string {
  const parts = [...s.matchReasons];
  if (s.distanceFromBiasNm != null) {
    parts.push(`${s.distanceFromBiasNm.toFixed(0)} nm from origin bias`);
  }
  return parts.join(' · ') || 'matching tender history';
}
