import { NextResponse } from 'next/server';
import { z } from 'zod';
import { analyzeBuyerEntityPricing } from '@procur/catalog';
import { verifyIntelligenceToken } from '../../../../lib/intelligence-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/intelligence/buyer-pricing
 *   ?buyer_entity_id=buyer:CH:vitol
 *   &buyer_name=Vitol
 *   &min_confidence=0.6
 *   &years_lookback=3
 *
 * Vex contract:
 *   { buyerEntityId, avgDeltaPct, medianDeltaPct, stddevDeltaPct,
 *     sampleSize, byCategory: [{categoryTag, avgDeltaPct, sampleSize}] }
 *
 * Vex sends either `buyer_entity_id` (synthesised by /find-buyers as
 * `buyer:{COUNTRY}:{slug-name}`) OR `buyer_name`. We need the
 * underlying buyer_name to query `award_price_deltas` since that
 * table joins on buyer_name (not entity ID). Resolution order:
 *   1. If `buyer_name` is set, use it verbatim.
 *   2. If `buyer_entity_id` is set, parse the slug-name back from
 *      it (the third colon-segment).
 */
const QuerySchema = z
  .object({
    buyer_entity_id: z.string().optional(),
    buyer_name: z.string().optional(),
    min_confidence: z.coerce.number().min(0).max(1).optional(),
    years_lookback: z.coerce.number().int().min(1).max(20).optional(),
  })
  .refine((v) => v.buyer_name || v.buyer_entity_id, {
    message: 'Either buyer_name or buyer_entity_id is required',
  });

function resolveBuyerName(args: {
  buyerName?: string;
  buyerEntityId?: string;
}): string | null {
  if (args.buyerName) return args.buyerName;
  if (args.buyerEntityId) {
    // Format: buyer:{COUNTRY}:{slug-name}
    const parts = args.buyerEntityId.split(':');
    if (parts.length >= 3) {
      // Reverse the slugify (replace dashes with spaces, title-case)
      return parts.slice(2).join(':').replace(/-/g, ' ');
    }
  }
  return null;
}

export async function GET(req: Request): Promise<Response> {
  const auth = verifyIntelligenceToken(req);
  if (auth) return auth;

  const url = new URL(req.url);
  const parsed = QuerySchema.safeParse({
    buyer_entity_id: url.searchParams.get('buyer_entity_id') ?? undefined,
    buyer_name: url.searchParams.get('buyer_name') ?? undefined,
    min_confidence: url.searchParams.get('min_confidence') ?? undefined,
    years_lookback: url.searchParams.get('years_lookback') ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'bad_request', detail: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const buyerName = resolveBuyerName({
    buyerName: parsed.data.buyer_name,
    buyerEntityId: parsed.data.buyer_entity_id,
  });
  if (!buyerName) {
    return NextResponse.json(
      { error: 'bad_request', detail: 'could not resolve buyer name' },
      { status: 400 },
    );
  }

  const daysBack =
    parsed.data.years_lookback != null ? parsed.data.years_lookback * 365 : undefined;
  const profile = await analyzeBuyerEntityPricing({
    buyerName,
    minConfidence: parsed.data.min_confidence,
    daysBack,
  });

  return NextResponse.json({
    buyerEntityId:
      parsed.data.buyer_entity_id ??
      `buyer:${buyerName.toLowerCase().replace(/\s+/g, '-')}`,
    avgDeltaPct: profile.avgDeltaPct,
    medianDeltaPct: profile.medianDeltaPct,
    stddevDeltaPct: profile.stddevDeltaPct,
    sampleSize: profile.sampleSize,
    byCategory: profile.byCategory,
  });
}
