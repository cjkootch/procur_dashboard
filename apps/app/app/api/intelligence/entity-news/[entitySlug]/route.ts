import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getEntityNewsEvents } from '@procur/catalog';
import { verifyIntelligenceToken } from '../../../../../lib/intelligence-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/intelligence/entity-news/{entitySlug}
 *   ?days_lookback=30
 *
 * Vex contract:
 *   { events: [{id, entitySlug, publishedAt, source, url, headline,
 *               summary, sentiment, tags[]}] }
 *
 * Resolves entitySlug against known_entities.slug first; falls back
 * to a trigram fuzzy-match on source_entity_name when no slug match.
 *
 * Field mapping from our entity_news_events row:
 *   - publishedAt: from event_date (YYYY-MM-DD; promote to ISO at
 *                  midnight UTC since date is the only granularity
 *                  we capture)
 *   - source     : from source ('sec-edgar' | 'recap-bankruptcy' |
 *                  'rss-trade-press')
 *   - url        : from source_url
 *   - headline   : derived — first 80 chars of summary or, if the
 *                  summary is short enough to be a headline already,
 *                  the whole thing
 *   - summary    : from summary
 *   - sentiment  : null today; LLM extraction step doesn't surface
 *                  sentiment yet (extract-distress-signal returns
 *                  hasDistressSignal but not polarity). Reserved.
 *   - tags       : derived from event_type
 */
const QuerySchema = z.object({
  days_lookback: z.coerce.number().int().min(1).max(3650).optional(),
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
    days_lookback: url.searchParams.get('days_lookback') ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'bad_request', detail: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const decoded = decodeURIComponent(entitySlug);
  const events = await getEntityNewsEvents({
    entitySlugOrName: decoded,
    daysBack: parsed.data.days_lookback,
  });

  const shaped = events.map((e) => {
    const headline =
      e.summary.length <= 80 ? e.summary : `${e.summary.slice(0, 77).trimEnd()}...`;
    const tags = [e.eventType.replace(/^sec_filing_/, '')];
    return {
      id: e.id,
      entitySlug: decoded,
      publishedAt: `${e.eventDate}T00:00:00Z`,
      source: e.source,
      url: e.sourceUrl,
      headline,
      summary: e.summary,
      sentiment: null as 'positive' | 'neutral' | 'negative' | null,
      tags,
    };
  });

  return NextResponse.json({ events: shaped });
}
