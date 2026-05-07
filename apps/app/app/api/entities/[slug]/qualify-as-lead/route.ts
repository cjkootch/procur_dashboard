import { NextResponse } from 'next/server';
import { z } from 'zod';
import {
  getCompanyDealDefaults,
  getEntityProfile,
  getMarketMoveBanner,
  getSupplierApproval,
  qualifyAsLead,
} from '@procur/catalog';
import { getCurrentUser, requireCompany } from '@procur/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/entities/[slug]/qualify-as-lead
 *   { contactName?, contactEmail?, contactPhone?, userNote? }
 *
 * One-click "qualify as lead" from the entity profile page. Mirrors
 * the match-queue path (and the assistant chat tool), keyed on the
 * canonical slug/UUID the profile page itself resolves with.
 *
 * Resolves the full profile via getEntityProfile (handles
 * known_entities slug OR external_suppliers UUID), then calls
 * qualifyAsLead. Returns the new lead's URL so the client can
 * navigate.
 */
const BodySchema = z.object({
  contactName: z.string().nullish(),
  contactEmail: z.string().email().nullish(),
  contactPhone: z.string().nullish(),
  userNote: z.string().max(2000).nullish(),
});

export async function POST(
  req: Request,
  { params }: { params: Promise<{ slug: string }> },
): Promise<Response> {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const { company } = await requireCompany();

  const { slug } = await params;

  let raw: unknown = {};
  try {
    raw = await req.json();
  } catch {
    raw = {};
  }
  const parsed = BodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'bad_request', detail: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const profile = await getEntityProfile(decodeURIComponent(slug));
  if (profile.primarySource === 'not_found') {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  // Pull the per-tenant approval, market snapshot, and trading
  // defaults in parallel — the lead-enrichment path treats all three
  // as authoritative procur context, so shipping them on qualify
  // saves a follow-up callback for every lead.
  const [approval, banner, defaults] = await Promise.all([
    getSupplierApproval(company.id, profile.canonicalKey).catch(() => null),
    getMarketMoveBanner(7, 0).catch(() => null), // threshold 0 → always returns the latest snapshot
    getCompanyDealDefaults(company.id).catch(() => null),
  ]);

  const marketContext = banner
    ? {
        benchmarkAsOf: banner.series[0]?.latestAsOf ?? null,
        brentSpotUsdPerBbl:
          banner.series.find((s) => s.seriesSlug === 'brent')?.latestPrice ?? null,
        nyhDieselSpotUsdPerGal:
          banner.series.find((s) => s.seriesSlug === 'nyh-diesel')?.latestPrice ?? null,
        nyhGasolineSpotUsdPerGal:
          banner.series.find((s) => s.seriesSlug === 'nyh-gasoline')?.latestPrice ??
          null,
      }
    : null;

  const procurTradingDefaults = defaults
    ? {
        defaultSourcingRegion: defaults.defaultSourcingRegion ?? null,
        targetGrossMarginPct: defaults.targetGrossMarginPct ?? null,
        targetNetMarginPerUsg: defaults.targetNetMarginPerUsg ?? null,
        monthlyFixedOverheadUsdDefault: defaults.monthlyFixedOverheadUsdDefault ?? null,
      }
    : null;

  const chatSummary =
    `Qualified from procur entity profile (${profile.primarySource === 'known_entity' ? 'curated rolodex' : 'portal-scraped'}). ` +
    `${profile.role ?? 'counterparty'}` +
    (profile.country ? ` based in ${profile.country}` : '') +
    (profile.categories.length > 0 ? `, categories: ${profile.categories.join(', ')}` : '') +
    '.';

  const result = await qualifyAsLead({
    sourceRef: `entity-profile:${profile.canonicalKey}`,
    triggeredBy: `procur-entity-profile:user:${user.id}`,
    legalName: profile.name,
    country: profile.country ?? null,
    domain: null,
    role: profile.role,
    contact:
      parsed.data.contactName || parsed.data.contactEmail || parsed.data.contactPhone
        ? {
            name: parsed.data.contactName ?? null,
            email: parsed.data.contactEmail ?? null,
            phone: parsed.data.contactPhone ?? null,
            title: null,
            linkedinUrl: null,
          }
        : null,
    chatSummary,
    userNote: parsed.data.userNote ?? null,
    procurMetadata: {
      ...(approval
        ? {
            procurApproval: {
              status: approval.status,
              approvedAt: approval.approvedAt,
              expiresAt: approval.expiresAt,
              notes: approval.notes,
            },
          }
        : {}),
      ...(marketContext ? { marketContext } : {}),
      ...(procurTradingDefaults ? { procurTradingDefaults } : {}),
    },
  });

  return NextResponse.json({
    ok: true,
    leadId: result.leadId,
    leadUrl: result.leadUrl,
    dedupedAgainstExisting: result.dedupedAgainstExisting,
  });
}
