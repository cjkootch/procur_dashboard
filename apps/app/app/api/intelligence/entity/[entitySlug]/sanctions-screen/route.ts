import { NextResponse } from 'next/server';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import {
  db,
  entitySanctionsScreens,
  externalSuppliers,
  knownEntities,
  SANCTIONS_CONFIDENCE_BANDS,
  SANCTIONS_SDN_TYPES,
  SANCTIONS_SOURCE_LISTS,
  SANCTIONS_STATUSES,
} from '@procur/db';
import { verifyIntelligenceToken } from '../../../../../../lib/intelligence-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/intelligence/entity/{entitySlug}/sanctions-screen
 *
 * Vex's SanctionsScreeningAgent calls this when it completes a screen
 * against US CSL / EU consolidated / UK OFSI for an org procur is also
 * tracking. Verdicts land in `entity_sanctions_screens` as an append
 * log — same suggestion-not-overwrite posture as contact-enrichment
 * (mig 0052). See migration 0055 for the full contract rationale.
 *
 * Auth: Authorization: Bearer ${PROCUR_API_TOKEN}.
 *
 * Idempotency: keyed on (vex_tenant_id, screen_id). A 5xx-induced
 * retry replays the same screen_id and we ON CONFLICT DO NOTHING.
 *   created: brand-new row landed
 *   noop:    we already had this (vex_tenant_id, screen_id) pair
 *
 * Multi-tenant: vex_tenant_id is opaque text — we never deref into
 * vex's user model. Two tenants screening the same entity with
 * different verdicts both produce rows; display surfaces resolve
 * "latest per (source_list)" by default.
 */
const MatchSchema = z.object({
  source_list: z.enum(SANCTIONS_SOURCE_LISTS),
  sdn_uid: z.string().min(1),
  programs: z.array(z.string().min(1)),
  confidence_band: z.enum(SANCTIONS_CONFIDENCE_BANDS),
  sdn_type: z.enum(SANCTIONS_SDN_TYPES),
});

const BodySchema = z
  .object({
    vex_tenant_id: z.string().min(1),
    screen_id: z.string().uuid(),
    legal_name: z.string().min(1),
    status: z.enum(SANCTIONS_STATUSES),
    sources_checked: z.array(z.string().min(1)).min(1),
    matches: z.array(MatchSchema),
    screened_at: z.string().datetime(),
    source: z.literal('vex'),
  })
  .refine(
    (b) => (b.status === 'clear' ? b.matches.length === 0 : b.matches.length > 0),
    {
      message:
        "matches must be empty when status='clear' and non-empty otherwise",
      path: ['matches'],
    },
  );

type ParsedBody = z.infer<typeof BodySchema>;

export async function POST(
  req: Request,
  { params }: { params: Promise<{ entitySlug: string }> },
): Promise<Response> {
  const auth = verifyIntelligenceToken(req);
  if (auth) return auth;

  const { entitySlug: rawSlug } = await params;
  const entitySlug = decodeURIComponent(rawSlug);

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }
  const parsed = BodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'unprocessable', detail: parsed.error.flatten() },
      { status: 422 },
    );
  }

  const exists = await entityExists(entitySlug);
  if (!exists) {
    return NextResponse.json(
      { kind: 'not_found', searched: entitySlug },
      { status: 404 },
    );
  }

  return await insertScreen(entitySlug, parsed.data);
}

async function insertScreen(
  entitySlug: string,
  body: ParsedBody,
): Promise<Response> {
  // Try insert; ON CONFLICT (vex_tenant_id, screen_id) DO NOTHING.
  // If a row comes back, it's brand-new. Otherwise we already had
  // this screen and treat the call as a no-op.
  const inserted = await db
    .insert(entitySanctionsScreens)
    .values({
      entitySlug,
      vexTenantId: body.vex_tenant_id,
      screenId: body.screen_id,
      legalName: body.legal_name,
      status: body.status,
      sourcesChecked: body.sources_checked,
      matches: body.matches,
      screenedAt: new Date(body.screened_at),
      source: body.source,
    })
    .onConflictDoNothing({
      target: [
        entitySanctionsScreens.vexTenantId,
        entitySanctionsScreens.screenId,
      ],
    })
    .returning({ id: entitySanctionsScreens.id });

  if (inserted[0]) {
    return NextResponse.json({ screenId: inserted[0].id, status: 'created' });
  }

  // Fetch existing for the response — vex doesn't strictly need our
  // row id back, but echoing it keeps the response shape consistent
  // with the 'created' branch and helps audit on their side.
  const existing = await db.query.entitySanctionsScreens.findFirst({
    where: and(
      eq(entitySanctionsScreens.vexTenantId, body.vex_tenant_id),
      eq(entitySanctionsScreens.screenId, body.screen_id),
    ),
    columns: { id: true },
  });
  if (!existing) {
    // Race between the failed insert and the select — extremely
    // unlikely but possible if the row was deleted between calls.
    // Treat as 500 so vex retries on the next cron pass.
    return NextResponse.json(
      { error: 'conflict_resolution_failed' },
      { status: 500 },
    );
  }
  return NextResponse.json({ screenId: existing.id, status: 'noop' });
}

/** Resolve entitySlug against known_entities.slug OR
 *  external_suppliers.id — same shape getEntityProfile accepts.
 *  Lifted verbatim from the contact-enrichment route. */
async function entityExists(entitySlug: string): Promise<boolean> {
  const isUuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      entitySlug,
    );
  if (isUuid) {
    const sup = await db.query.externalSuppliers.findFirst({
      where: eq(externalSuppliers.id, entitySlug),
      columns: { id: true },
    });
    if (sup) return true;
    // fall through — UUIDs that don't match a supplier could still
    // be a known_entity slug coincidentally shaped like one.
  }
  const ke = await db.query.knownEntities.findFirst({
    where: eq(knownEntities.slug, entitySlug),
    columns: { slug: true },
  });
  return Boolean(ke);
}
