import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getEntityProfile } from '@procur/catalog';
import { getCurrentUser } from '@procur/auth';
import { pushVexContact } from '@/lib/vex-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/entities/[slug]/push-to-vex
 *   { contactName?, contactEmail?, contactPhone?, userNote? }
 *
 * One-click "push to vex" from the entity profile page. Mirrors the
 * match-queue push-to-vex flow (and the assistant chat tool), but
 * keyed on the canonical slug/UUID the profile page itself resolves
 * with — so the button has all the context the page already shows.
 *
 * Resolves the full profile via getEntityProfile (which handles
 * known_entities slug OR external_suppliers UUID), then calls
 * pushVexContact with the same commercialContext shape the assistant
 * uses. On success, returns vexRecordUrl so the client can open the
 * vex record in a new tab.
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

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'https://app.procur.app';
  const tender = profile.publicTenderActivity;
  const last = tender?.mostRecentAwardDate ?? null;
  const daysSinceLastAward =
    last != null
      ? Math.max(
          0,
          Math.floor(
            (Date.now() - new Date(last).getTime()) / (24 * 60 * 60 * 1000),
          ),
        )
      : null;

  const result = await pushVexContact({
    source: 'procur',
    sourceRef: `entity-profile:${profile.canonicalKey}`,
    legalName: profile.name,
    country: profile.country ?? null,
    role: profile.role,
    contactName: parsed.data.contactName ?? null,
    contactEmail: parsed.data.contactEmail ?? null,
    contactPhone: parsed.data.contactPhone ?? null,
    commercialContext: {
      categories: profile.categories,
      awardCount: tender?.totalAwards ?? 0,
      awardTotalUsd: tender?.totalValueUsd ?? null,
      daysSinceLastAward,
      distressSignals: [],
      notes: profile.notes,
      procurEntityProfileUrl: `${appUrl}/entities/${profile.canonicalKey}`,
    },
    originationContext: {
      triggeredBy: `procur-entity-profile:user:${user.id}`,
      chatSummary:
        `Pushed from procur entity profile (${profile.primarySource === 'known_entity' ? 'curated rolodex' : 'portal-scraped'}). ` +
        `${profile.role ?? 'counterparty'}` +
        (profile.country ? ` based in ${profile.country}` : '') +
        (profile.categories.length > 0 ? `, categories: ${profile.categories.join(', ')}` : '') +
        '.',
      userNote: parsed.data.userNote ?? null,
      pushedAt: new Date().toISOString(),
    },
  });

  if (!result.ok) {
    return NextResponse.json(
      { error: 'vex_push_failed', message: result.error, status: result.status },
      { status: 502 },
    );
  }

  return NextResponse.json({
    ok: true,
    vexContactId: result.data.vexContactId,
    vexRecordUrl: result.data.vexRecordUrl,
    dedupedAgainstExisting: result.data.dedupedAgainstExisting,
  });
}
