import { NextResponse } from 'next/server';
import { z } from 'zod';
import { findDistressedSuppliers } from '@procur/catalog';
import { verifyIntelligenceToken } from '../../../../lib/intelligence-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/intelligence/distressed-suppliers
 *   ?category_tag=diesel
 *   &countries=DO,JM,TT
 *   &min_prev_awards=3
 *   &velocity_change_max=-0.5
 *   &include_news_events=true
 *   &limit=25
 *
 * Wraps `findDistressedSuppliers`. Velocity columns come from the
 * supplier_capability_summary MV (refreshed nightly). The news-event
 * JOIN reads from entity_news_events — the table exists as of
 * migration 0048 but stays empty until ingest workers ship
 * (SEC EDGAR / PACER / RSS — separate PRs). Until then the
 * recentNewsEvents arrays are empty.
 */
const QuerySchema = z.object({
  category_tag: z.string().optional(),
  countries: z.string().optional(),
  min_prev_awards: z.coerce.number().int().min(1).max(50).optional(),
  velocity_change_max: z.coerce.number().min(-1).max(0).optional(),
  include_news_events: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v == null ? undefined : v === 'true')),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export async function GET(req: Request): Promise<Response> {
  const auth = verifyIntelligenceToken(req);
  if (auth) return auth;

  const url = new URL(req.url);
  const parsed = QuerySchema.safeParse({
    category_tag: url.searchParams.get('category_tag') ?? undefined,
    countries: url.searchParams.get('countries') ?? undefined,
    min_prev_awards: url.searchParams.get('min_prev_awards') ?? undefined,
    velocity_change_max: url.searchParams.get('velocity_change_max') ?? undefined,
    include_news_events: url.searchParams.get('include_news_events') ?? undefined,
    limit: url.searchParams.get('limit') ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'bad_request', detail: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const countries = parsed.data.countries
    ?.split(',')
    .map((s) => s.trim().toUpperCase())
    .filter((s) => s.length === 2);

  const suppliers = await findDistressedSuppliers({
    categoryTag: parsed.data.category_tag,
    countries,
    minPrevAwards: parsed.data.min_prev_awards,
    velocityChangeMax: parsed.data.velocity_change_max,
    includeNewsEvents: parsed.data.include_news_events,
    limit: parsed.data.limit,
  });

  return NextResponse.json({ suppliers });
}
