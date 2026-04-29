import { NextResponse } from 'next/server';
import { z } from 'zod';
import { analyzeSupplier, analyzeSupplierPricing } from '@procur/catalog';
import { verifyIntelligenceToken } from '../../../../../../lib/intelligence-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/intelligence/supplier/{idOrName}/pricing
 *   ?min_confidence=0.6
 *   &years_lookback=3
 *   &category_filter=diesel
 *
 * Wraps `analyzeSupplierPricing`. Resolves name → id via analyzeSupplier
 * if the path is non-UUID. Returns the vex-shaped pricing profile:
 *
 *   { supplierId, avgDeltaPct, medianDeltaPct, stddevDeltaPct,
 *     sampleSize, byCategory: [{categoryTag, avgDeltaPct, sampleSize}] }
 *
 * Note: our underlying query doesn't return a per-category breakdown
 * directly — we derive `byCategory` from the recentSamples grouped by
 * category. For deeper per-category statistics a future iteration
 * could push the GROUP BY into the SQL.
 */
const QuerySchema = z.object({
  min_confidence: z.coerce.number().min(0).max(1).optional(),
  years_lookback: z.coerce.number().int().min(1).max(20).optional(),
  category_filter: z.string().optional(),
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(
  req: Request,
  { params }: { params: Promise<{ idOrName: string }> },
): Promise<Response> {
  const auth = verifyIntelligenceToken(req);
  if (auth) return auth;

  const { idOrName } = await params;
  const url = new URL(req.url);
  const parsed = QuerySchema.safeParse({
    min_confidence: url.searchParams.get('min_confidence') ?? undefined,
    years_lookback: url.searchParams.get('years_lookback') ?? undefined,
    category_filter: url.searchParams.get('category_filter') ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'bad_request', detail: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const decoded = decodeURIComponent(idOrName);
  let supplierId = idOrName;
  if (!UUID_RE.test(idOrName)) {
    const resolved = await analyzeSupplier({ supplierName: decoded });
    if (resolved.kind === 'not_found') {
      return NextResponse.json(
        { kind: 'not_found', searched: decoded },
        { status: 404 },
      );
    }
    if (resolved.kind === 'disambiguation_needed') {
      return NextResponse.json(
        {
          kind: 'disambiguation_needed',
          candidates: resolved.candidates.map((c) => ({
            supplierId: c.supplierId,
            legalName: c.canonicalName,
            country: c.country,
            awardCount: c.totalAwards,
          })),
        },
        { status: 409 },
      );
    }
    supplierId = resolved.supplier.id;
  }

  const daysBack =
    parsed.data.years_lookback != null ? parsed.data.years_lookback * 365 : undefined;
  const profile = await analyzeSupplierPricing({
    supplierId,
    minConfidence: parsed.data.min_confidence,
    daysBack,
  });

  // Derive byCategory from recentSamples. Each sample has
  // categoryTags (array) and deltaPct; group by tag, average pct,
  // count.
  const cat = parsed.data.category_filter;
  const byTag = new Map<string, { sum: number; count: number }>();
  for (const sample of profile.recentSamples) {
    for (const tag of sample.categoryTags) {
      if (cat && tag !== cat) continue;
      const acc = byTag.get(tag) ?? { sum: 0, count: 0 };
      acc.sum += sample.deltaPct;
      acc.count += 1;
      byTag.set(tag, acc);
    }
  }
  const byCategory = [...byTag.entries()].map(([categoryTag, { sum, count }]) => ({
    categoryTag,
    avgDeltaPct: count > 0 ? sum / count : null,
    sampleSize: count,
  }));

  return NextResponse.json({
    supplierId,
    avgDeltaPct: profile.avgDeltaPct,
    medianDeltaPct:
      profile.medianDeltaUsdPerBbl != null && profile.avgDeltaUsdPerBbl != null
        ? // No native median-pct on the profile — derive proportionally
          // from the median-bbl using the same ratio as avg-pct/avg-bbl.
          (profile.medianDeltaUsdPerBbl * (profile.avgDeltaPct ?? 0)) /
          (profile.avgDeltaUsdPerBbl || 1)
        : null,
    stddevDeltaPct:
      profile.stddevDeltaUsdPerBbl != null && profile.avgDeltaUsdPerBbl != null
        ? (profile.stddevDeltaUsdPerBbl * (profile.avgDeltaPct ?? 0)) /
          (profile.avgDeltaUsdPerBbl || 1)
        : null,
    sampleSize: profile.awardCount,
    byCategory,
  });
}
