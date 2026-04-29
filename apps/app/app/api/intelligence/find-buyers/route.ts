import { NextResponse } from 'next/server';
import { z } from 'zod';
import { findBuyersForCommodityOffer } from '@procur/catalog';
import { verifyIntelligenceToken } from '../../../../lib/intelligence-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/intelligence/find-buyers
 *
 * Body (snake_case in):
 *   { category_tag, description_keywords?, buyer_countries?,
 *     years_lookback?, min_awards?, limit? }
 *
 * Response (camelCase out, vex contract):
 *   { candidates: [{buyerEntityId, legalName, country,
 *                   awardCount, awardTotalUsd, avgAwardSizeUsd,
 *                   lastAwardAt, relevanceScore, rationale}],
 *     totalCount }
 *
 * `buyerEntityId` doesn't exist in our awards graph (buyers are
 * agency_name strings, not external_suppliers rows). We synthesise
 * one from `${country}:${legalName}` so vex can use it as a stable
 * dedup key without needing real entity IDs to be backfilled first.
 */
const BodySchema = z.object({
  category_tag: z.string().min(1),
  description_keywords: z.array(z.string()).optional(),
  buyer_countries: z.array(z.string().length(2)).optional(),
  years_lookback: z.number().int().min(1).max(20).optional(),
  min_awards: z.number().int().min(1).max(50).optional(),
  limit: z.number().int().min(1).max(200).optional(),
});

function buyerEntityId(country: string | null | undefined, name: string): string {
  return `buyer:${(country ?? 'XX').toUpperCase()}:${name.toLowerCase().replace(/\s+/g, '-')}`;
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

  const candidates = await findBuyersForCommodityOffer({
    categoryTag: parsed.data.category_tag,
    descriptionKeywords: parsed.data.description_keywords,
    buyerCountries: parsed.data.buyer_countries,
    yearsLookback: parsed.data.years_lookback,
    minAwards: parsed.data.min_awards,
    limit: parsed.data.limit,
  });

  // Relevance is awardCount × log(avgSize) — heuristic, normalised
  // to 0-1 across the result set so vex can rank without re-scaling.
  const maxAwards = candidates.reduce((m, c) => Math.max(m, c.awardsCount), 1);

  const shaped = candidates.map((c) => {
    const avg =
      c.totalValueUsd != null && c.awardsCount > 0
        ? c.totalValueUsd / c.awardsCount
        : null;
    const relevanceScore = c.awardsCount / maxAwards;
    const rationale =
      `${c.awardsCount} awards in ${parsed.data.category_tag}` +
      (c.buyerCountry ? ` from ${c.buyerCountry}` : '') +
      (c.totalValueUsd != null ? ` (~$${Math.round(c.totalValueUsd).toLocaleString()} total)` : '');
    return {
      buyerEntityId: buyerEntityId(c.buyerCountry, c.buyerName),
      legalName: c.buyerName,
      country: c.buyerCountry,
      awardCount: c.awardsCount,
      awardTotalUsd: c.totalValueUsd,
      avgAwardSizeUsd: avg,
      lastAwardAt: null as string | null,
      relevanceScore,
      rationale,
    };
  });

  return NextResponse.json({ candidates: shaped, totalCount: shaped.length });
}
