import { NextResponse } from 'next/server';
import { z } from 'zod';
import { findSuppliersForTender } from '@procur/catalog';
import { verifyIntelligenceToken } from '../../../../lib/intelligence-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/intelligence/find-suppliers-for-tender
 * Body: FindSuppliersForTenderArgs
 *
 * Wraps `findSuppliersForTender`. Sell-side bidder ranking. Pass either
 * an `opportunityId` (the function derives category/country from the
 * opportunity row) or explicit `categoryTag` / `buyerCountry` /
 * `descriptionKeywords` / `beneficiaryCountry`.
 *
 * No companyId scope is applied — the underlying query treats all
 * public award data as visible. The first arg to the function is
 * intentionally `null` for the service-to-service caller.
 */
const BodySchema = z.object({
  opportunityId: z.string().uuid().optional(),
  categoryTag: z.string().optional(),
  descriptionKeywords: z.array(z.string()).optional(),
  buyerCountry: z.string().length(2).optional(),
  beneficiaryCountry: z.string().length(2).optional(),
  yearsLookback: z.number().int().min(1).max(20).optional(),
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

  const result = await findSuppliersForTender(null, parsed.data);
  return NextResponse.json(result);
}
