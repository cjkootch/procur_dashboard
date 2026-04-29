import { NextResponse } from 'next/server';
import { z } from 'zod';
import { findBuyersForCommodityOffer } from '@procur/catalog';
import { verifyIntelligenceToken } from '../../../../lib/intelligence-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/intelligence/find-buyers
 * Body: CommodityOfferSpec
 *
 * Wraps `findBuyersForCommodityOffer`. Buy-side discovery: given an
 * offer the supplier is shopping, surface candidate buyers ranked by
 * recent volume in (categoryTag × buyerCountries).
 */
const BodySchema = z.object({
  categoryTag: z.string().min(1),
  descriptionKeywords: z.array(z.string()).optional(),
  unspscCodes: z.array(z.string()).optional(),
  buyerCountries: z.array(z.string().length(2)).optional(),
  yearsLookback: z.number().int().min(1).max(20).optional(),
  minAwards: z.number().int().min(1).max(50).optional(),
  limit: z.number().int().min(1).max(200).optional(),
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

  const candidates = await findBuyersForCommodityOffer(parsed.data);
  return NextResponse.json({ candidates });
}
