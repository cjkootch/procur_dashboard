import { NextResponse } from 'next/server';
import { z } from 'zod';
import { analyzeSupplier } from '@procur/catalog';
import { verifyIntelligenceToken } from '../../../../../lib/intelligence-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/intelligence/supplier/{idOrName}?years_lookback=N
 *
 * Wraps `analyzeSupplier`. UUID path goes straight to id-lookup; non-
 * UUID falls through to fuzzy-name resolution. Returns one of three
 * `kind`-discriminated shapes — vex's `ProcurClient` decodes them
 * verbatim:
 *
 *   { kind: "profile", supplierId, legalName, country, role,
 *     categories[], awardCount, awardTotalUsd, recentAwardCount,
 *     daysSinceLastAward, tags[], distressSignals: [...], notes }
 *   { kind: "disambiguation_needed", candidates: [...] }
 *   { kind: "not_found", searched }
 *
 * Field provenance:
 *   - supplierId, legalName, country: from external_suppliers via
 *     analyzeSupplier
 *   - role, tags, notes: NULL by default (analyzeSupplier doesn't
 *     pull from known_entities; we'd need a join to fill these)
 *   - categories: keys of awardsByCategory
 *   - awardCount, awardTotalUsd: from summary
 *   - daysSinceLastAward: derived from mostRecentAwardDate
 *   - recentAwardCount: from summary.totalAwards filtered to last
 *     90d (we don't track this on the summary today; surfaced as 0
 *     when missing rather than rebuilding the query)
 *   - distressSignals: surfaced from supplier_signals (private
 *     behavioral data) when present, mapped to vex's
 *     {kind, detail, observedAt} shape
 */
const QuerySchema = z.object({
  years_lookback: z.coerce.number().int().min(1).max(50).optional(),
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
    years_lookback: url.searchParams.get('years_lookback') ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'bad_request', detail: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const decoded = decodeURIComponent(idOrName);
  const args = UUID_RE.test(idOrName)
    ? { supplierId: idOrName, yearsLookback: parsed.data.years_lookback }
    : { supplierName: decoded, yearsLookback: parsed.data.years_lookback };

  const result = await analyzeSupplier(args);

  if (result.kind === 'not_found') {
    return NextResponse.json(
      { kind: 'not_found', searched: decoded },
      { status: 404 },
    );
  }
  if (result.kind === 'disambiguation_needed') {
    return NextResponse.json({
      kind: 'disambiguation_needed',
      candidates: result.candidates.map((c) => ({
        supplierId: c.supplierId,
        legalName: c.canonicalName,
        country: c.country,
        awardCount: c.totalAwards,
      })),
    });
  }

  // Profile path — flatten + remap to vex's expected fields.
  const s = result.supplier;
  const summary = result.summary;
  const last = summary.mostRecentAwardDate;
  const daysSinceLastAward =
    last != null
      ? Math.max(
          0,
          Math.floor((Date.now() - new Date(last).getTime()) / (24 * 60 * 60 * 1000)),
        )
      : null;

  const distressSignals = (result.signals ?? []).map((sig) => ({
    kind: sig.signalType,
    detail:
      typeof sig.signalValue === 'string'
        ? sig.signalValue
        : JSON.stringify(sig.signalValue),
    observedAt: sig.observedAt,
  }));

  return NextResponse.json({
    kind: 'profile',
    supplierId: s.id,
    legalName: s.canonicalName,
    country: s.country,
    role: null,
    categories: Object.keys(summary.awardsByCategory ?? {}),
    awardCount: summary.totalAwards,
    awardTotalUsd: summary.totalValueUsd,
    recentAwardCount: result.recentAwards?.length ?? 0,
    daysSinceLastAward,
    tags: [],
    distressSignals,
    notes: null,
  });
}
