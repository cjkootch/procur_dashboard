import { NextResponse } from 'next/server';
import { z } from 'zod';
import { evaluateOfferAgainstHistory } from '@procur/catalog';
import { verifyIntelligenceToken } from '../../../../lib/intelligence-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/intelligence/evaluate-offer
 * Body: { buyerCountry, categoryTag, offerPriceUsdPerBbl, ... }
 *
 * Wraps `evaluateOfferAgainstHistory`. Returns the empirical p25/p75
 * band the buyer typically pays plus a z-score verdict on whether the
 * supplied offer is competitive vs that history.
 */
const BodySchema = z.object({
  buyerCountry: z.string().length(2),
  categoryTag: z.string().min(1),
  offerPriceUsdPerBbl: z.number().positive(),
  minConfidence: z.number().min(0).max(1).optional(),
  daysBack: z.number().int().min(1).max(3650).optional(),
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

  const result = await evaluateOfferAgainstHistory(parsed.data);
  return NextResponse.json(result);
}
