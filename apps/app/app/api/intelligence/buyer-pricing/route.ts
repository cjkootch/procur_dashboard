import { NextResponse } from 'next/server';
import { z } from 'zod';
import { analyzeBuyerPricing } from '@procur/catalog';
import { verifyIntelligenceToken } from '../../../../lib/intelligence-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/intelligence/buyer-pricing
 *   ?buyerCountry=DO&categoryTag=diesel&minConfidence=0.6&daysBack=1095
 *
 * Wraps `analyzeBuyerPricing`. Returns the historical p25/median/p75
 * band of award_price_deltas (delta-vs-spot) for a (country × category).
 */
const QuerySchema = z.object({
  buyerCountry: z.string().length(2),
  categoryTag: z.string().min(1),
  minConfidence: z.coerce.number().min(0).max(1).optional(),
  daysBack: z.coerce.number().int().min(1).max(3650).optional(),
});

export async function GET(req: Request): Promise<Response> {
  const auth = verifyIntelligenceToken(req);
  if (auth) return auth;

  const url = new URL(req.url);
  const parsed = QuerySchema.safeParse({
    buyerCountry: url.searchParams.get('buyerCountry') ?? undefined,
    categoryTag: url.searchParams.get('categoryTag') ?? undefined,
    minConfidence: url.searchParams.get('minConfidence') ?? undefined,
    daysBack: url.searchParams.get('daysBack') ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'bad_request', detail: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const profile = await analyzeBuyerPricing(parsed.data);
  return NextResponse.json(profile);
}
