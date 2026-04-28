import { NextResponse } from 'next/server';
import { requireCompany } from '@procur/auth';
import {
  findBuyersForCommodityOffer,
  type CommodityOfferSpec,
} from '@procur/catalog';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Reverse-search endpoint for the supplier-graph buy-side workflow.
 *
 * POST { categoryTag, descriptionKeywords?, unspscCodes?, buyerCountries?,
 *        yearsLookback?, minAwards?, limit? }
 *  → { buyers: CandidateBuyer[], spec: CommodityOfferSpec }
 *
 * Reads from public-domain tables (`awards`, `agencies`,
 * `external_suppliers`); no tenant scoping needed at the data layer.
 * Auth-gated to any logged-in Procur user via requireCompany() so the
 * surface isn't anonymously crawlable.
 */
export async function POST(req: Request): Promise<Response> {
  // requireCompany() redirects to /sign-in or /onboarding for browser
  // navigation. For an API JSON POST we want a 401 instead — wrap the
  // call so we can convert.
  try {
    await requireCompany();
  } catch {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  let spec: CommodityOfferSpec;
  try {
    spec = (await req.json()) as CommodityOfferSpec;
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  if (!spec.categoryTag || typeof spec.categoryTag !== 'string') {
    return NextResponse.json(
      { error: 'categoryTag is required' },
      { status: 400 },
    );
  }

  const buyers = await findBuyersForCommodityOffer(spec);
  return NextResponse.json({ buyers, spec });
}
