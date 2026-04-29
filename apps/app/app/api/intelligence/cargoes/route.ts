import { NextResponse } from 'next/server';
import { z } from 'zod';
import { findRecentPortCalls } from '@procur/catalog';
import { verifyIntelligenceToken } from '../../../../lib/intelligence-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/intelligence/cargoes
 *   ?destination_country=US
 *   &destination_entity_slug=...
 *   &origin_country=...
 *   &vessel_category=tanker
 *   &days_lookback=30
 *   &min_confidence=weak
 *
 * Vex's contract names this "cargoes" but procur's underlying data
 * is AIS-derived port calls — load/discharge linkage isn't
 * inferred yet. We surface every port call as a proto-cargo with
 * confidence='weak' so vex sees structured data and can wire its
 * UI; once cargo-trip inference lands (separate roadmap item) the
 * confidence rises and supplier/buyer attribution fills in.
 *
 * Field provenance (today):
 *   - cargoId      : `${mmsi}:${portSlug}` (synthesised; survives across
 *                    runs because (mmsi, port_slug) is the natural key
 *                    of one call cluster)
 *   - supplierName : null — we don't know who owned the cargo
 *   - buyerCountry : portCountry (proxy: refining at port = buyer)
 *   - commodity    : null — not derivable from AIS alone
 *   - quantityMt   : null — same
 *   - arrivedAt    : the cluster's first-seen timestamp
 *   - vesselName   : from vessels.name when we have static data
 *   - confidence   : "weak" for all rows (proto-cargo, not inferred)
 */
const QuerySchema = z.object({
  destination_country: z.string().length(2).optional(),
  destination_entity_slug: z.string().optional(),
  origin_country: z.string().length(2).optional(),
  vessel_category: z.string().optional(),
  days_lookback: z.coerce.number().int().min(1).max(365).optional(),
  min_confidence: z.enum(['weak', 'medium', 'strong']).optional(),
});

export async function GET(req: Request): Promise<Response> {
  const auth = verifyIntelligenceToken(req);
  if (auth) return auth;

  const url = new URL(req.url);
  const parsed = QuerySchema.safeParse({
    destination_country: url.searchParams.get('destination_country') ?? undefined,
    destination_entity_slug:
      url.searchParams.get('destination_entity_slug') ?? undefined,
    origin_country: url.searchParams.get('origin_country') ?? undefined,
    vessel_category: url.searchParams.get('vessel_category') ?? undefined,
    days_lookback: url.searchParams.get('days_lookback') ?? undefined,
    min_confidence: url.searchParams.get('min_confidence') ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'bad_request', detail: parsed.error.flatten() },
      { status: 400 },
    );
  }

  // Today's coverage: map destination_country directly. Other
  // filters (origin_country, destination_entity_slug, vessel_category,
  // min_confidence) require cargo-trip inference and are accepted
  // for forward-compat but ignored.
  // min_confidence="medium"/"strong" naturally returns empty since
  // every row we emit is "weak" until inference ships.
  if (parsed.data.min_confidence && parsed.data.min_confidence !== 'weak') {
    return NextResponse.json({ cargoes: [], totalCount: 0 });
  }

  const calls = await findRecentPortCalls({
    country: parsed.data.destination_country,
    daysBack: parsed.data.days_lookback ?? 30,
    limit: 200,
  });

  const cargoes = calls.map((c) => ({
    cargoId: `${c.mmsi}:${c.portSlug}`,
    supplierName: null as string | null,
    buyerCountry: c.portCountry,
    commodity: null as string | null,
    quantityMt: null as number | null,
    arrivedAt: c.arrivalAt,
    vesselName: c.vesselName,
    confidence: 'weak' as const,
  }));

  return NextResponse.json({ cargoes, totalCount: cargoes.length });
}
