import { NextResponse } from 'next/server';
import { z } from 'zod';
import { findRecentPortCalls } from '@procur/catalog';
import { verifyIntelligenceToken } from '../../../../lib/intelligence-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/intelligence/cargoes
 *   ?portSlug=ras-lanuf&country=LY&portType=crude-loading&daysBack=30&limit=50
 *
 * Returns recent vessel port calls — the closest data we currently
 * have to an inferred cargo timeline. True cargo inference (linking
 * loading-port calls to discharge-port calls into a single cargo
 * entity) is a follow-up; today's response is one row per port call
 * and the `inferred=false` flag in the envelope tells callers so
 * downstream tooling can frame results accordingly.
 */
const QuerySchema = z.object({
  portSlug: z.string().optional(),
  country: z.string().length(2).optional(),
  portType: z
    .enum(['crude-loading', 'refinery', 'transshipment', 'mixed'])
    .optional(),
  daysBack: z.coerce.number().int().min(1).max(365).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

export async function GET(req: Request): Promise<Response> {
  const auth = verifyIntelligenceToken(req);
  if (auth) return auth;

  const url = new URL(req.url);
  const parsed = QuerySchema.safeParse({
    portSlug: url.searchParams.get('portSlug') ?? undefined,
    country: url.searchParams.get('country') ?? undefined,
    portType: url.searchParams.get('portType') ?? undefined,
    daysBack: url.searchParams.get('daysBack') ?? undefined,
    limit: url.searchParams.get('limit') ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'bad_request', detail: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const portCalls = await findRecentPortCalls(parsed.data);
  return NextResponse.json({
    inferred: false,
    note:
      'Returning AIS-derived port calls one row per vessel-port event. ' +
      'Cargo inference (load↔discharge linkage) is a follow-up.',
    portCalls,
  });
}
