import 'server-only';
import { and, eq } from 'drizzle-orm';
import {
  db,
  alertProfiles,
  entityDocuments,
  ENTITY_DOCUMENT_CATEGORIES,
  externalSuppliers,
  knownEntities,
  opportunities,
  pursuits,
  supplierApprovals,
  type EntityDocumentCategory,
  type SupplierApprovalStatus,
} from '@procur/db';

/**
 * Discover-side mutations for the AI assistant write tools.
 *
 * Kept separate from queries.ts so the read/write surfaces are easy to
 * audit. Every function here implies a user took an action via the
 * assistant — log accordingly upstream if we want activity tracking.
 *
 * All mutations are scoped by AssistantContext.userId / companyId,
 * which the agent loop guarantees comes from the authenticated
 * handshake token (never user-supplied at the tool layer).
 */

export type CreateAlertProfileInput = {
  userId: string;
  companyId: string;
  name: string;
  jurisdictions?: string[];
  categories?: string[];
  keywords?: string[];
  excludeKeywords?: string[];
  minValueUsd?: number;
  maxValueUsd?: number;
  frequency?: 'instant' | 'daily' | 'weekly';
};

export type CreateAlertProfileResult = {
  id: string;
  name: string;
  frequency: string;
  active: boolean;
  manageUrl: string;
};

/**
 * Create a new alert profile for the user. Profile is active +
 * email-enabled by default; the user can toggle either off in the
 * main app's alerts settings page after creation.
 *
 * The alerts cron task (in @procur/email-digest) reads alert_profiles
 * once per cycle and matches against new opportunities — this row
 * becomes effective on the next run (instant: ~5 min, daily: next
 * morning, weekly: next Monday).
 */
export async function createAlertProfile(
  input: CreateAlertProfileInput,
): Promise<CreateAlertProfileResult> {
  const trimmedName = input.name.trim();
  if (!trimmedName) throw new Error('alert profile name is required');

  const [row] = await db
    .insert(alertProfiles)
    .values({
      userId: input.userId,
      companyId: input.companyId,
      name: trimmedName.slice(0, 200),
      jurisdictions: input.jurisdictions && input.jurisdictions.length > 0
        ? input.jurisdictions
        : null,
      categories: input.categories && input.categories.length > 0
        ? input.categories
        : null,
      keywords: input.keywords && input.keywords.length > 0 ? input.keywords : null,
      excludeKeywords:
        input.excludeKeywords && input.excludeKeywords.length > 0
          ? input.excludeKeywords
          : null,
      minValue: input.minValueUsd != null ? String(input.minValueUsd) : null,
      maxValue: input.maxValueUsd != null ? String(input.maxValueUsd) : null,
      frequency: input.frequency ?? 'daily',
      emailEnabled: true,
      active: true,
    })
    .returning({
      id: alertProfiles.id,
      name: alertProfiles.name,
      frequency: alertProfiles.frequency,
      active: alertProfiles.active,
    });
  if (!row) throw new Error('alert profile insert returned no row');

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'https://app.procur.app';
  return {
    id: row.id,
    name: row.name,
    frequency: row.frequency,
    active: row.active,
    manageUrl: `${appUrl}/alerts`,
  };
}

export type AddOpportunityToPursuitInput = {
  companyId: string;
  opportunitySlug: string;
};

export type AddOpportunityToPursuitResult = {
  pursuitId: string;
  opportunityTitle: string;
  alreadyExisted: boolean;
  manageUrl: string;
};

/**
 * Save a Discover opportunity to the user's company pursuit pipeline.
 *
 * Idempotent — pursuits has a UNIQUE INDEX on (companyId, opportunityId)
 * so re-adding the same opportunity returns the existing pursuit row
 * with alreadyExisted=true, rather than failing or creating a duplicate.
 *
 * The new pursuit lands in stage='identification' (the default) — the
 * user can advance it through the capture flow in the main app. Notes,
 * stage advancement, capture answers etc. all live in the main app's
 * capture UI; this tool just creates the pipeline entry.
 *
 * Refuses to add a private uploaded opportunity that's NOT owned by
 * the calling company — preserves Discover's privacy boundary
 * (uploaded RFPs are tenant-scoped).
 */
export async function addOpportunityToPursuit(
  input: AddOpportunityToPursuitInput,
): Promise<AddOpportunityToPursuitResult> {
  const opp = await db.query.opportunities.findFirst({
    where: eq(opportunities.slug, input.opportunitySlug),
    columns: { id: true, title: true, companyId: true },
  });
  if (!opp) throw new Error(`opportunity not found: ${input.opportunitySlug}`);
  if (opp.companyId && opp.companyId !== input.companyId) {
    throw new Error('cannot pursue another tenant\'s private uploaded opportunity');
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'https://app.procur.app';

  // Insert; on dup-key conflict, do nothing and re-fetch.
  const [inserted] = await db
    .insert(pursuits)
    .values({
      companyId: input.companyId,
      opportunityId: opp.id,
    })
    .onConflictDoNothing({
      target: [pursuits.companyId, pursuits.opportunityId],
    })
    .returning({ id: pursuits.id });

  if (inserted) {
    return {
      pursuitId: inserted.id,
      opportunityTitle: opp.title,
      alreadyExisted: false,
      manageUrl: `${appUrl}/capture/pursuits/${inserted.id}`,
    };
  }

  const existing = await db.query.pursuits.findFirst({
    where: and(
      eq(pursuits.companyId, input.companyId),
      eq(pursuits.opportunityId, opp.id),
    ),
    columns: { id: true },
  });
  if (!existing) {
    throw new Error('pursuit insert returned no row and no existing row found');
  }
  return {
    pursuitId: existing.id,
    opportunityTitle: opp.title,
    alreadyExisted: true,
    manageUrl: `${appUrl}/capture/pursuits/${existing.id}`,
  };
}

// ─── Supplier approvals ────────────────────────────────────────

export type UpsertSupplierApprovalInput = {
  companyId: string;
  userId?: string | null;
  entitySlug: string;
  /** Snapshot of the entity name at write time. Useful for the
   *  settings summary panel when the entity row hasn't been fetched. */
  entityName?: string | null;
  status: SupplierApprovalStatus;
  /** When to set approvedAt. Defaults to now() iff status moved into
   *  approved_*; otherwise null (clears any prior approvedAt). */
  approvedAt?: Date | null;
  expiresAt?: Date | null;
  notes?: string | null;
};

/**
 * Soft-error class so callers (server actions, AI tool handlers,
 * route handlers) can branch on a known shape rather than parsing
 * `Error.message`. Used for "entity doesn't exist" — the caller
 * surfaces it as a 400 / Zod-shaped error instead of crashing.
 */
export class SupplierApprovalEntityMissingError extends Error {
  readonly entitySlug: string;
  constructor(entitySlug: string) {
    super(
      `Cannot record an approval for entity_slug='${entitySlug}' — no known_entity ` +
        `or external_supplier matches that slug. If this came from a chat-curated ` +
        `propose_create_known_entity proposal, apply that proposal first; the ` +
        `entity row needs to exist before its approval state can be tracked.`,
    );
    this.name = 'SupplierApprovalEntityMissingError';
    this.entitySlug = entitySlug;
  }
}

/**
 * Returns true when the slug resolves to either a known_entities
 * row or an external_suppliers row (the same shape getEntityProfile
 * accepts as canonicalKey). Used by upsertSupplierApproval to
 * refuse writes against orphan slugs — see the trace where chat
 * created a supplier_approvals row pointing at a slug whose
 * propose_create_known_entity proposal had not been applied yet
 * (resulting in /entities/<slug> 404).
 */
export async function entitySlugExists(entitySlug: string): Promise<boolean> {
  const [ke, es] = await Promise.all([
    db.query.knownEntities.findFirst({
      where: eq(knownEntities.slug, entitySlug),
      columns: { id: true },
    }),
    db.query.externalSuppliers.findFirst({
      where: eq(externalSuppliers.id, entitySlug),
      columns: { id: true },
    }),
  ]);
  return Boolean(ke || es);
}

/**
 * Insert or update the (company, entitySlug) approval row. UNIQUE
 * constraint on (company_id, entity_slug) means we use ON CONFLICT
 * to flip an existing row's status without creating a duplicate —
 * re-engagement is a status update, not a new row (matches the
 * design comment in 0054).
 *
 * Refuses to write when entitySlug doesn't resolve. The slug column
 * is text (not FK) by design so it can match either known_entities
 * or external_suppliers, but that means we have to enforce
 * existence at the application layer — otherwise a chat session
 * can leave orphan rows pointing at not-yet-applied proposed
 * entities.
 */
export async function upsertSupplierApproval(
  input: UpsertSupplierApprovalInput,
): Promise<{ id: string; created: boolean }> {
  if (!(await entitySlugExists(input.entitySlug))) {
    throw new SupplierApprovalEntityMissingError(input.entitySlug);
  }
  const isApproved =
    input.status === 'approved_with_kyc' || input.status === 'approved_without_kyc';
  const approvedAt =
    input.approvedAt !== undefined ? input.approvedAt : isApproved ? new Date() : null;

  const existing = await db.query.supplierApprovals.findFirst({
    where: and(
      eq(supplierApprovals.companyId, input.companyId),
      eq(supplierApprovals.entitySlug, input.entitySlug),
    ),
    columns: { id: true },
  });

  if (existing) {
    // undefined = caller didn't pass the field, so preserve existing value.
    // Explicit null = caller is clearing it.
    const patch: Partial<typeof supplierApprovals.$inferInsert> = {
      status: input.status,
      approvedAt,
      updatedAt: new Date(),
    };
    if (input.expiresAt !== undefined) patch.expiresAt = input.expiresAt;
    if (input.notes !== undefined) patch.notes = input.notes;
    if (input.entityName !== undefined && input.entityName !== null) {
      patch.entityName = input.entityName;
    }
    await db
      .update(supplierApprovals)
      .set(patch)
      .where(eq(supplierApprovals.id, existing.id));
    return { id: existing.id, created: false };
  }

  const inserted = await db
    .insert(supplierApprovals)
    .values({
      companyId: input.companyId,
      createdBy: input.userId ?? null,
      entitySlug: input.entitySlug,
      entityName: input.entityName ?? null,
      status: input.status,
      approvedAt,
      expiresAt: input.expiresAt ?? null,
      notes: input.notes ?? null,
    })
    .returning({ id: supplierApprovals.id });
  return { id: inserted[0]!.id, created: true };
}

// ─── Entity document attachment (chat-side flow) ─────────────────

export type AttachEntityDocumentInput = {
  companyId: string;
  userId: string;
  entitySlug: string;
  filename: string;
  blobUrl: string;
  sizeBytes?: number | null;
  mimeType?: string | null;
  category?: EntityDocumentCategory | null;
  description?: string | null;
};

/**
 * Record a document attachment against a rolodex entity. Mirrors
 * what the EntityDocumentsPanel UI flow does, but called from the
 * chat tool (`attach_document_to_entity`) when the user has uploaded
 * a file in the chat composer and wants to associate it with an
 * entity profile.
 *
 * The Vercel Blob upload happens client-side (assistant-uploads/
 * <companyId>/<uuid> path); this mutation just writes the DB row.
 *
 * Throws `EntityNotFoundError` when entitySlug doesn't exist in
 * either known_entities OR external_suppliers — same contract as
 * upsertSupplierApproval, so chat traces show "create the entity
 * first" guidance instead of an orphan attachment.
 */
export class EntityDocumentEntityMissingError extends Error {
  readonly entitySlug: string;
  constructor(entitySlug: string) {
    super(`Entity '${entitySlug}' not found.`);
    this.name = 'EntityDocumentEntityMissingError';
    this.entitySlug = entitySlug;
  }
}

export async function attachEntityDocument(
  input: AttachEntityDocumentInput,
): Promise<{ id: string; uploadedAt: Date }> {
  if (!(await entitySlugExists(input.entitySlug))) {
    throw new EntityDocumentEntityMissingError(input.entitySlug);
  }
  // Validate category against the runtime enum even though TS already
  // narrows — defense in depth in case a non-typesafe caller wires up.
  if (
    input.category != null &&
    !ENTITY_DOCUMENT_CATEGORIES.includes(input.category)
  ) {
    throw new Error(
      `Invalid category '${input.category}'. Valid: ${ENTITY_DOCUMENT_CATEGORIES.join(', ')}.`,
    );
  }
  const [inserted] = await db
    .insert(entityDocuments)
    .values({
      companyId: input.companyId,
      entitySlug: input.entitySlug,
      filename: input.filename,
      blobUrl: input.blobUrl,
      sizeBytes: input.sizeBytes ?? null,
      mimeType: input.mimeType ?? null,
      category: input.category ?? null,
      description: input.description ?? null,
      uploadedBy: input.userId,
    })
    .returning({ id: entityDocuments.id, uploadedAt: entityDocuments.uploadedAt });
  return { id: inserted!.id, uploadedAt: inserted!.uploadedAt };
}
