import { NextResponse } from 'next/server';
import { verifyIntelligenceToken } from '../../../../../lib/intelligence-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/intelligence/entity-news/[entitySlug]
 *
 * Layer-3 entity-news endpoint. Backing schema (`entity_news_events`)
 * + ingestion workers (SEC EDGAR / PACER / trade-press RSS) are not
 * yet built — see `docs/intelligence-layers-brief.md` Layer 3.
 * Returns 501 so vex can wire the client now.
 */
export async function GET(
  req: Request,
  _params: { params: Promise<{ entitySlug: string }> },
): Promise<Response> {
  const auth = verifyIntelligenceToken(req);
  if (auth) return auth;

  return NextResponse.json(
    {
      error: 'not_implemented',
      detail:
        'Entity news events are on the roadmap. See ' +
        'docs/intelligence-layers-brief.md (Layer 3).',
    },
    { status: 501 },
  );
}
