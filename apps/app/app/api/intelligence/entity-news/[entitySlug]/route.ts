import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getEntityNewsEvents } from '@procur/catalog';
import { verifyIntelligenceToken } from '../../../../../lib/intelligence-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/intelligence/entity-news/[entitySlug]
 *   ?days_back=365&include_noise=false&limit=50
 *
 * Wraps `getEntityNewsEvents`. Resolves entitySlug against
 * known_entities.slug first; falls back to a trigram fuzzy match on
 * source_entity_name when no slug match.
 *
 * The backing entity_news_events table exists as of migration 0048
 * but stays empty until ingest workers ship (SEC EDGAR / PACER / RSS
 * — separate PRs). Until then this endpoint returns
 * `{ events: [], note: '...' }`.
 */
const QuerySchema = z.object({
  days_back: z.coerce.number().int().min(1).max(3650).optional(),
  include_noise: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v == null ? undefined : v === 'true')),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

export async function GET(
  req: Request,
  { params }: { params: Promise<{ entitySlug: string }> },
): Promise<Response> {
  const auth = verifyIntelligenceToken(req);
  if (auth) return auth;

  const { entitySlug } = await params;
  const url = new URL(req.url);
  const parsed = QuerySchema.safeParse({
    days_back: url.searchParams.get('days_back') ?? undefined,
    include_noise: url.searchParams.get('include_noise') ?? undefined,
    limit: url.searchParams.get('limit') ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'bad_request', detail: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const events = await getEntityNewsEvents({
    entitySlugOrName: decodeURIComponent(entitySlug),
    daysBack: parsed.data.days_back,
    includeNoise: parsed.data.include_noise,
    limit: parsed.data.limit,
  });

  return NextResponse.json({
    entitySlugOrName: decodeURIComponent(entitySlug),
    events,
    note:
      events.length === 0
        ? 'No events. entity_news_events stays empty until ingest workers ' +
          '(SEC EDGAR / PACER / trade-press RSS) ship — see ' +
          'docs/intelligence-layers-brief.md §6.4.'
        : undefined,
  });
}
