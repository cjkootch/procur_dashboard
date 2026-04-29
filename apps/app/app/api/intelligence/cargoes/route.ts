import { NextResponse } from 'next/server';
import { z } from 'zod';
import { inferCargoTripsFromAis } from '@procur/catalog';
import { verifyIntelligenceToken } from '../../../../lib/intelligence-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/intelligence/cargoes
 *   ?destination_country=US
 *   &destination_entity_slug=...      (reserved; not yet wired)
 *   &origin_country=...
 *   &vessel_category=tanker            (reserved; not yet wired)
 *   &days_lookback=30
 *   &min_confidence=weak|medium|strong
 *
 * Vex contract response:
 *   { cargoes: [{cargoId, supplierName, buyerCountry, commodity,
 *               quantityMt, arrivedAt, vesselName, confidence}],
 *     totalCount }
 *
 * Inference moves up from the original "every port call is a
 * proto-cargo with confidence='weak'" passthrough (PR #263). This
 * version pairs each MMSI's consecutive (load → discharge) port
 * calls into a real cargo trip, with per-row confidence:
 *
 *   strong : load=crude-loading + discharge=refinery
 *   medium : either end is mixed / transshipment
 *   weak   : everything else (kept for the response envelope —
 *            min_confidence=weak surfaces them; medium/strong
 *            filter them out)
 *
 * Fields still null:
 *   - supplierName : we don't yet attribute the vessel's load port
 *                    to a known supplier (next iteration: join load
 *                    port to operator via known_entities).
 *   - commodity    : not derivable from AIS alone — vessel's last
 *                    cargo isn't broadcast.
 *   - quantityMt   : not derivable.
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

  const trips = await inferCargoTripsFromAis({
    daysBack: parsed.data.days_lookback ?? 30,
    destinationCountry: parsed.data.destination_country,
    originCountry: parsed.data.origin_country,
    minConfidence: parsed.data.min_confidence,
    limit: 200,
  });

  const cargoes = trips.map((t) => ({
    cargoId: t.cargoId,
    supplierName: null as string | null,
    buyerCountry: t.dischargePortCountry,
    commodity: null as string | null,
    quantityMt: null as number | null,
    arrivedAt: t.arrivedAt,
    vesselName: t.vesselName,
    confidence: t.confidence,
  }));

  return NextResponse.json({ cargoes, totalCount: cargoes.length });
}
