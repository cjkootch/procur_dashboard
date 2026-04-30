import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db, matchQueue, knownEntities, externalSuppliers } from '@procur/db';
import { eq } from 'drizzle-orm';
import { getEntityProfile, updateMatchQueueStatus } from '@procur/catalog';
import { getCurrentUser } from '@procur/auth';
import { pushVexContact } from '@/lib/vex-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/match-queue/[id]/push-to-vex
 *   { contactName?, contactEmail?, contactPhone?, userNote? }
 *
 * One-click "push to vex" from the match-queue UI. Mirrors the
 * assistant chat-flow (propose_push_to_vex_contact + apply.ts →
 * pushVex) but skips the proposal/confirm step since the row itself
 * already represents an explicit user intent.
 *
 * On success: atomically transitions the row to status='pushed-to-vex'
 * so the queue de-duplicates re-pushes and hides the row from open.
 * On vex failure: row is left at status='open' so the user can retry.
 */
const BodySchema = z.object({
  contactName: z.string().nullish(),
  contactEmail: z.string().email().nullish(),
  contactPhone: z.string().nullish(),
  userNote: z.string().max(2000).nullish(),
});

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const { id } = await params;

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

  const row = await db.query.matchQueue.findFirst({
    where: eq(matchQueue.id, id),
  });
  if (!row) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  if (row.status !== 'open') {
    return NextResponse.json(
      { error: 'not_open', currentStatus: row.status },
      { status: 409 },
    );
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'https://app.procur.app';

  let legalName = row.sourceEntityName;
  let country = row.sourceEntityCountry;
  let role: string | null = null;
  let categories: string[] = row.categoryTags ?? [];
  let awardCount = 0;
  let awardTotalUsd: number | null = null;
  let daysSinceLastAward: number | null = null;
  let notes: string | null = null;
  let procurEntityProfileUrl = '';
  let sourceRef: string;

  // Resolve the right id-shape for getEntityProfile: it accepts a
  // known_entities.slug OR an external_suppliers.id (UUID), but NOT
  // a known_entities.id. The match_queue row only carries the FK
  // UUID, so look the slug up first.
  let resolveKey: string | null = null;
  if (row.knownEntityId) {
    const ke = await db.query.knownEntities.findFirst({
      where: eq(knownEntities.id, row.knownEntityId),
      columns: { slug: true },
    });
    if (ke) resolveKey = ke.slug;
  } else if (row.externalSupplierId) {
    const sup = await db.query.externalSuppliers.findFirst({
      where: eq(externalSuppliers.id, row.externalSupplierId),
      columns: { id: true },
    });
    if (sup) resolveKey = sup.id;
  }

  if (resolveKey) {
    const profile = await getEntityProfile(resolveKey);
    if (profile.primarySource !== 'not_found') {
      legalName = profile.name;
      country = profile.country ?? country;
      role = profile.role;
      categories = profile.categories.length > 0 ? profile.categories : categories;
      awardCount = profile.publicTenderActivity?.totalAwards ?? 0;
      awardTotalUsd = profile.publicTenderActivity?.totalValueUsd ?? null;
      const last = profile.publicTenderActivity?.mostRecentAwardDate ?? null;
      daysSinceLastAward =
        last != null
          ? Math.max(
              0,
              Math.floor(
                (Date.now() - new Date(last).getTime()) / (24 * 60 * 60 * 1000),
              ),
            )
          : null;
      notes = profile.notes;
      procurEntityProfileUrl = `${appUrl}/entities/${profile.canonicalKey}`;
      sourceRef = `match-queue:${row.id}:${profile.canonicalKey}`;
    } else {
      sourceRef = `match-queue:${row.id}`;
    }
  } else {
    sourceRef = `match-queue:${row.id}`;
  }

  const chatSummary =
    `Surfaced via procur match queue (${row.signalType}/${row.signalKind}, ` +
    `score ${Number(row.score).toFixed(1)}). ${row.rationale}`;

  const result = await pushVexContact({
    source: 'procur',
    sourceRef,
    legalName,
    country: country ?? null,
    role,
    contactName: parsed.data.contactName ?? null,
    contactEmail: parsed.data.contactEmail ?? null,
    contactPhone: parsed.data.contactPhone ?? null,
    contactTitle: null,
    contactLinkedinUrl: null,
    commercialContext: {
      categories,
      awardCount,
      awardTotalUsd,
      daysSinceLastAward,
      distressSignals: [],
      notes,
      procurEntityProfileUrl,
    },
    originationContext: {
      triggeredBy: `procur-match-queue:user:${user.id}`,
      chatSummary,
      userNote: parsed.data.userNote ?? null,
      pushedAt: new Date().toISOString(),
    },
    // Match-queue pushes don't currently resolve approval / market /
    // trading-defaults; vex's worker can fall back to its own data
    // for those. Future iteration can mirror the entity-profile
    // route's resolution path here too.
    approvalContext: null,
    productSpecs: [],
    sourceDocuments: [],
    marketContext: null,
    procurTradingDefaults: null,
  });

  if (!result.ok) {
    return NextResponse.json(
      { error: 'vex_push_failed', message: result.error, status: result.status },
      { status: 502 },
    );
  }

  await updateMatchQueueStatus({ id: row.id, status: 'pushed-to-vex' });

  return NextResponse.json({
    ok: true,
    vexContactId: result.data.vexContactId,
    vexRecordUrl: result.data.vexRecordUrl,
    dedupedAgainstExisting: result.data.dedupedAgainstExisting,
  });
}
