import { NextResponse } from 'next/server';
import { z } from 'zod';
import { findEntitiesNearLocation } from '@procur/catalog';
import { verifyIntelligenceToken } from '../../../../lib/intelligence-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/intelligence/proximity-suppliers
 *   ?destination_lat=37.94&destination_lon=23.64
 *   &radius_nm=1500
 *   &category_tag=diesel
 *   &roles=refiner,producer
 *   &tag=mediterranean-refiner
 *   &limit=50
 *
 * Wraps `findEntitiesNearLocation`. Returns known_entities filtered by
 * haversine distance to a destination port, sorted by distance ASC.
 * Excludes entities where lat/lng is null (run
 * `pnpm --filter @procur/db backfill-entity-coords` to populate).
 */
const QuerySchema = z.object({
  destination_lat: z.coerce.number().min(-90).max(90),
  destination_lon: z.coerce.number().min(-180).max(180),
  radius_nm: z.coerce.number().positive().max(20000),
  category_tag: z.string().optional(),
  roles: z.string().optional(),
  tag: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

export async function GET(req: Request): Promise<Response> {
  const auth = verifyIntelligenceToken(req);
  if (auth) return auth;

  const url = new URL(req.url);
  const parsed = QuerySchema.safeParse({
    destination_lat: url.searchParams.get('destination_lat') ?? undefined,
    destination_lon: url.searchParams.get('destination_lon') ?? undefined,
    radius_nm: url.searchParams.get('radius_nm') ?? undefined,
    category_tag: url.searchParams.get('category_tag') ?? undefined,
    roles: url.searchParams.get('roles') ?? undefined,
    tag: url.searchParams.get('tag') ?? undefined,
    limit: url.searchParams.get('limit') ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'bad_request', detail: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const roles = parsed.data.roles
    ?.split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const entities = await findEntitiesNearLocation({
    destinationLat: parsed.data.destination_lat,
    destinationLon: parsed.data.destination_lon,
    radiusNm: parsed.data.radius_nm,
    roles,
    categoryTag: parsed.data.category_tag,
    tag: parsed.data.tag,
    limit: parsed.data.limit,
  });

  return NextResponse.json({ entities });
}
