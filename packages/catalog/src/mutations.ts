import 'server-only';
import { and, eq } from 'drizzle-orm';
import {
  db,
  alertProfiles,
  opportunities,
  pursuits,
  supplierApprovals,
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
 * Insert or update the (company, entitySlug) approval row. UNIQUE
 * constraint on (company_id, entity_slug) means we use ON CONFLICT
 * to flip an existing row's status without creating a duplicate —
 * re-engagement is a status update, not a new row (matches the
 * design comment in 0054).
 */
export async function upsertSupplierApproval(
  input: UpsertSupplierApprovalInput,
): Promise<{ id: string; created: boolean }> {
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
    await db
      .update(supplierApprovals)
      .set({
        status: input.status,
        approvedAt,
        expiresAt: input.expiresAt ?? null,
        notes: input.notes ?? null,
        entityName: input.entityName ?? undefined,
        updatedAt: new Date(),
      })
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
