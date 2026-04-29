import { NextResponse } from 'next/server';
import { verifyIntelligenceToken } from '../../../../lib/intelligence-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/intelligence/distressed-suppliers
 *
 * Layer-3 distress-intelligence endpoint. Backing query
 * (`find_distressed_suppliers`) is not yet implemented — see
 * `docs/intelligence-layers-brief.md` Layer 3. Returns 501 so vex can
 * wire the client now and we don't block them on the schema work.
 *
 * Auth still enforced — keeps the endpoint behaviour honest (401 vs 501
 * has to be reachable for both the deployed and unbuilt path).
 */
export async function GET(req: Request): Promise<Response> {
  const auth = verifyIntelligenceToken(req);
  if (auth) return auth;

  return NextResponse.json(
    {
      error: 'not_implemented',
      detail:
        'Distress intelligence (entity_news_events + supplier-velocity ' +
        'columns) is on the roadmap. See docs/intelligence-layers-brief.md ' +
        '(Layer 3).',
    },
    { status: 501 },
  );
}
