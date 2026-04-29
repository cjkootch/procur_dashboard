import { NextResponse } from 'next/server';
import { z } from 'zod';
import { listOpportunities } from '@procur/catalog';
import { verifyIntelligenceToken } from '../../../../../lib/intelligence-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/intelligence/opportunities/recent
 *   ?since=2026-04-01T00:00:00Z
 *   &category_tag=diesel              (single category for v1)
 *   &beneficiary_country=DR           (single ISO-2 for v1)
 *   &min_value_usd=100000
 *   &max_value_usd=50000000
 *   &limit=50
 *
 * Wraps `listOpportunities` with the parameter shape vex's
 * ProcurOpportunityWatcher polls. v1 supports a single category /
 * country filter — multi-category and `volume_mt_min/max` from the
 * canonical brief are deferred; opportunities don't carry a structured
 * volume field on `opportunities` today (volume is on `awards`).
 */
const QuerySchema = z.object({
  since: z
    .string()
    .datetime({ offset: true })
    .optional()
    .describe('ISO 8601 instant. Defaults to 24h ago.'),
  category_tag: z.string().optional(),
  beneficiary_country: z.string().optional(),
  min_value_usd: z.coerce.number().int().min(0).optional(),
  max_value_usd: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

export async function GET(req: Request): Promise<Response> {
  const auth = verifyIntelligenceToken(req);
  if (auth) return auth;

  const url = new URL(req.url);
  const parsed = QuerySchema.safeParse({
    since: url.searchParams.get('since') ?? undefined,
    category_tag: url.searchParams.get('category_tag') ?? undefined,
    beneficiary_country: url.searchParams.get('beneficiary_country') ?? undefined,
    min_value_usd: url.searchParams.get('min_value_usd') ?? undefined,
    max_value_usd: url.searchParams.get('max_value_usd') ?? undefined,
    limit: url.searchParams.get('limit') ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'bad_request', detail: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const sinceInstant = parsed.data.since
    ? new Date(parsed.data.since)
    : new Date(Date.now() - 24 * 60 * 60 * 1000);

  const { rows, total } = await listOpportunities({
    publishedAfter: sinceInstant,
    category: parsed.data.category_tag,
    beneficiaryCountry: parsed.data.beneficiary_country,
    minValueUsd: parsed.data.min_value_usd,
    maxValueUsd: parsed.data.max_value_usd,
    page: 1,
    perPage: parsed.data.limit ?? 50,
    sort: 'recent',
    scope: 'open',
  });

  return NextResponse.json({
    since: sinceInstant.toISOString(),
    total,
    shown: rows.length,
    opportunities: rows,
  });
}
