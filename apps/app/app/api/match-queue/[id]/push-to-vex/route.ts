import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db, matchQueue, knownEntities, externalSuppliers } from '@procur/db';
import type { ProcurSignal } from '@procur/db';
import { eq } from 'drizzle-orm';
import {
  getEntityProfile,
  qualifyAsLead,
  updateMatchQueueStatus,
} from '@procur/catalog';
import { getCurrentUser } from '@procur/auth';

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

  let legalName = row.sourceEntityName;
  let country = row.sourceEntityCountry;
  let role: string | null = null;
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

  // Push-time WHY context. Match queue is the canonical source — every
  // row already carries score, rationale, signal kind/type, and a
  // dated observation. The brief's ProcurSignal kinds: rfq |
  // tender_award | vessel_clearance | customs_event | news | other.
  const pushReason =
    `Match queue ${row.signalKind} signal at score ${Number(row.score).toFixed(2)}. ` +
    row.rationale;
  const signalKindToProcur: Record<string, ProcurSignal['kind']> = {
    distress_event: 'news',
    velocity_drop: 'tender_award',
    new_award: 'tender_award',
    sec_filing_force_majeure: 'news',
    bankruptcy_filing: 'news',
    press_distress_signal: 'news',
    leadership_change: 'news',
  };
  const signalKind = signalKindToProcur[row.signalKind] ?? 'other';
  const procurSignals: ProcurSignal[] = [
    {
      kind: signalKind,
      occurredAt: new Date(row.observedAt).toISOString(),
      source: row.sourceTable + ':' + row.sourceId,
      narrative: row.rationale,
      // match_queue.score is 0-9.99; normalize to 0-1.
      weight: Math.min(Number(row.score) / 10, 1),
    },
  ];

  const result = await qualifyAsLead({
    sourceRef,
    triggeredBy: `procur-match-queue:user:${user.id}`,
    legalName,
    country: country ?? null,
    domain: null,
    role,
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
      pushReason,
      signals: procurSignals,
      matchQueue: {
        score: Math.min(Number(row.score) / 10, 1),
        reasons: [row.rationale],
      },
    },
  });

  await updateMatchQueueStatus({ id: row.id, status: 'pushed-to-vex' });

  return NextResponse.json({
    ok: true,
    leadId: result.leadId,
    leadUrl: result.leadUrl,
    dedupedAgainstExisting: result.dedupedAgainstExisting,
  });
}
