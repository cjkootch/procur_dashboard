import { NextResponse } from 'next/server';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import {
  db,
  entityContactEnrichments,
  externalSuppliers,
  knownEntities,
} from '@procur/db';
import { verifyIntelligenceToken } from '../../../../../../lib/intelligence-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/intelligence/entity/{entitySlug}/contact-enrichment
 *
 * Vex's ContactEnrichmentAgent calls this when it lands a high-
 * confidence email / title / phone / linkedin URL for a contact at
 * a procur-sourced entity. We treat the payload as a SUGGESTION,
 * not an overwrite — rows land in entity_contact_enrichments tagged
 * source='vex' so an operator can promote them to a primary
 * contact-of-record later. See migration 0052 for rationale.
 *
 * Auth: Authorization: Bearer ${PROCUR_API_TOKEN} via the same
 * verifyIntelligenceToken helper every other intelligence route uses.
 *
 * Idempotency: repeated calls with the same (entitySlug, source,
 * normalized name) merge field-by-field, taking the higher-confidence
 * value per field. Status reflects what changed:
 *   created: brand-new row
 *   updated: existing row, ≥1 field improved
 *   noop:    existing row, every incoming field equal-or-inferior
 */
const FieldSchema = z.object({
  value: z.string().min(1),
  confidence: z.number().min(0).max(1),
  source_url: z.string().url().nullable(),
});

const BodySchema = z
  .object({
    name: z.string().min(1),
    fields: z
      .object({
        email: FieldSchema.optional(),
        title: FieldSchema.optional(),
        phone: FieldSchema.optional(),
        linkedinUrl: FieldSchema.optional(),
      })
      .refine(
        (f) => f.email || f.title || f.phone || f.linkedinUrl,
        { message: 'at least one field must be present' },
      ),
    source: z.literal('vex'),
    enriched_at: z.string().datetime(),
  });

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

  const normalized = normalizeName(parsed.data.name);
  const incoming = mapIncomingFields(parsed.data);

  const existing = await db.query.entityContactEnrichments.findFirst({
    where: and(
      eq(entityContactEnrichments.entitySlug, entitySlug),
      eq(entityContactEnrichments.source, parsed.data.source),
      eq(entityContactEnrichments.contactNameNormalized, normalized),
    ),
  });

  if (!existing) {
    const [row] = await db
      .insert(entityContactEnrichments)
      .values({
        entitySlug,
        contactName: parsed.data.name,
        contactNameNormalized: normalized,
        source: parsed.data.source,
        enrichedAt: new Date(parsed.data.enriched_at),
        ...incoming.values,
      })
      .returning({ id: entityContactEnrichments.id });
    if (!row) {
      return NextResponse.json({ error: 'insert_failed' }, { status: 500 });
    }
    return NextResponse.json({ contactId: row.id, status: 'created' });
  }

  // Field-by-field merge: keep existing unless incoming has a higher
  // confidence (or fills a previously-null field).
  const merged = mergeFields(existing, incoming);
  if (!merged.changed) {
    return NextResponse.json({ contactId: existing.id, status: 'noop' });
  }

  await db
    .update(entityContactEnrichments)
    .set({
      ...merged.values,
      contactName: parsed.data.name,
      enrichedAt: new Date(parsed.data.enriched_at),
      updatedAt: new Date(),
    })
    .where(eq(entityContactEnrichments.id, existing.id));

  return NextResponse.json({ contactId: existing.id, status: 'updated' });
}

/** Resolve entitySlug against known_entities.slug OR
 *  external_suppliers.id — same shape getEntityProfile accepts. */
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
    // be a known_entity slug coincidentally shaped like one (unlikely
    // but cheap to check).
  }
  const ke = await db.query.knownEntities.findFirst({
    where: eq(knownEntities.slug, entitySlug),
    columns: { slug: true },
  });
  return Boolean(ke);
}

function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

type IncomingField = {
  value: string;
  confidence: string;
  sourceUrl: string | null;
};

function mapIncomingFields(body: ParsedBody): {
  values: Partial<typeof entityContactEnrichments.$inferInsert>;
  raw: {
    email?: IncomingField;
    title?: IncomingField;
    phone?: IncomingField;
    linkedinUrl?: IncomingField;
  };
} {
  const values: Partial<typeof entityContactEnrichments.$inferInsert> = {};
  const raw: ReturnType<typeof mapIncomingFields>['raw'] = {};

  if (body.fields.email) {
    const f = toField(body.fields.email);
    raw.email = f;
    values.email = f.value;
    values.emailConfidence = f.confidence;
    values.emailSourceUrl = f.sourceUrl;
  }
  if (body.fields.title) {
    const f = toField(body.fields.title);
    raw.title = f;
    values.title = f.value;
    values.titleConfidence = f.confidence;
    values.titleSourceUrl = f.sourceUrl;
  }
  if (body.fields.phone) {
    const f = toField(body.fields.phone);
    raw.phone = f;
    values.phone = f.value;
    values.phoneConfidence = f.confidence;
    values.phoneSourceUrl = f.sourceUrl;
  }
  if (body.fields.linkedinUrl) {
    const f = toField(body.fields.linkedinUrl);
    raw.linkedinUrl = f;
    values.linkedinUrl = f.value;
    values.linkedinConfidence = f.confidence;
    values.linkedinSourceUrl = f.sourceUrl;
  }
  return { values, raw };
}

function toField(f: { value: string; confidence: number; source_url: string | null }): IncomingField {
  return {
    value: f.value,
    confidence: f.confidence.toFixed(2),
    sourceUrl: f.source_url,
  };
}

type EnrichmentRow = typeof entityContactEnrichments.$inferSelect;

function mergeFields(
  existing: EnrichmentRow,
  incoming: ReturnType<typeof mapIncomingFields>,
): {
  changed: boolean;
  values: Partial<typeof entityContactEnrichments.$inferInsert>;
} {
  const values: Partial<typeof entityContactEnrichments.$inferInsert> = {};
  let changed = false;

  const fields = ['email', 'title', 'phone', 'linkedinUrl'] as const;
  for (const field of fields) {
    const inc = incoming.raw[field];
    if (!inc) continue;

    const valueCol =
      field === 'linkedinUrl' ? 'linkedinUrl' : (field as 'email' | 'title' | 'phone');
    const confCol = `${field}Confidence` as
      | 'emailConfidence'
      | 'titleConfidence'
      | 'phoneConfidence'
      | 'linkedinConfidence';
    const srcCol = `${field}SourceUrl` as
      | 'emailSourceUrl'
      | 'titleSourceUrl'
      | 'phoneSourceUrl'
      | 'linkedinSourceUrl';

    const oldValue = existing[valueCol];
    const oldConf = existing[confCol];
    const oldConfNum = oldConf == null ? null : Number(oldConf);
    const incConfNum = Number(inc.confidence);

    // Take incoming when:
    //   - we had nothing, OR
    //   - incoming confidence is strictly higher
    const shouldTake =
      oldValue == null ||
      oldConfNum == null ||
      incConfNum > oldConfNum;

    if (shouldTake && (oldValue !== inc.value || oldConfNum !== incConfNum)) {
      values[valueCol] = inc.value;
      values[confCol] = inc.confidence;
      values[srcCol] = inc.sourceUrl;
      changed = true;
    }
  }

  return { changed, values };
}
