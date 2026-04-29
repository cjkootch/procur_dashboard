import { NextResponse } from 'next/server';
import { z } from 'zod';
import { findDistressedSuppliers } from '@procur/catalog';
import { verifyIntelligenceToken } from '../../../../lib/intelligence-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/intelligence/distressed-suppliers
 *   ?category_tag=diesel
 *   &countries=CH,DE
 *   &min_prev_awards=3
 *   &velocity_change_max=-0.5
 *   &include_news_events=true
 *   &limit=25
 *
 * Vex contract:
 *   { suppliers: [{supplierEntityId, legalName, country,
 *                  distressSignal: {kind, detail, observedAt},
 *                  awardVelocityChangePct}],
 *     totalCount }
 *
 * Velocity comes from supplier_capability_summary (rolling 90/90
 * windows from migration 0047). distressSignal is sourced from the
 * supplier's most-recent entity_news_events row when available;
 * when no event exists we synthesise a velocity-only signal so vex
 * sees structured data (kind: 'velocity_drop', detail: the
 * distressReasons[0] from the underlying query, observedAt:
 * mostRecentAwardDate).
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

  const shaped = suppliers.map((s) => {
    const news = s.recentNewsEvents[0] ?? null;
    const distressSignal = news
      ? {
          kind: news.eventType,
          detail: news.summary,
          observedAt: news.eventDate,
        }
      : {
          kind: 'velocity_drop',
          detail: s.distressReasons[0] ?? 'award velocity dropped',
          observedAt: s.mostRecentAwardDate,
        };
    return {
      supplierEntityId: s.supplierId,
      legalName: s.organisationName,
      country: s.country,
      distressSignal,
      awardVelocityChangePct: s.velocityChangePct * 100,
    };
  });

  return NextResponse.json({ suppliers: shaped, totalCount: shaped.length });
}
