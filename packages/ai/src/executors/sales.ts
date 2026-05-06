import { eq, sql } from 'drizzle-orm';
import {
  approvals,
  contactOrgMemberships,
  contacts,
  db,
  events,
  followUps,
  leads,
  organizationProducts,
  organizationRelationships,
  organizations,
} from '@procur/db';
import { createId } from '../agents/id';

/**
 * Per-action executors for Phase 4 sales surfaces. Each function is
 * idempotent on the approval id (short-circuits if applied_at is set)
 * and stamps applied_object_id + applied_at on success.
 *
 * Wired into apps/app/app/approvals/actions.ts → approveApprovalAction
 * via the dispatchExecutor switch.
 */

interface ExecutorResult {
  ok: boolean;
  appliedObjectId?: string;
  error?: string;
}

async function alreadyApplied(approvalId: string): Promise<boolean> {
  const rows = await db
    .select({ appliedAt: approvals.appliedAt })
    .from(approvals)
    .where(eq(approvals.id, approvalId))
    .limit(1);
  return rows[0]?.appliedAt != null;
}

async function stampApplied(
  approvalId: string,
  appliedObjectId: string,
  verb: string,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  const occurredAt = new Date();
  await db
    .update(approvals)
    .set({ appliedObjectId, appliedAt: occurredAt })
    .where(eq(approvals.id, approvalId));
  await db
    .insert(events)
    .values({
      id: createId(),
      verb,
      subjectType: 'approval',
      subjectId: approvalId,
      actorType: 'system',
      actorId: 'sales-executor',
      objectType: verb.split('.')[0] ?? 'object',
      objectId: appliedObjectId,
      occurredAt,
      idempotencyKey: `${verb}:${approvalId}`,
      metadata,
    })
    .onConflictDoNothing({
      target: [events.occurredAt, events.idempotencyKey],
    });
}

// ============================================================================
// crm.create_company
// ============================================================================

export interface CreateCompanyPayload {
  legalName: string;
  domain?: string;
  industry?: string;
  rationale: string;
}

export function parseCreateCompanyPayload(
  proposedPayload: Record<string, unknown> | null | undefined,
): CreateCompanyPayload | null {
  if (!proposedPayload || typeof proposedPayload !== 'object') return null;
  const legalName = proposedPayload['legalName'];
  const rationale = proposedPayload['rationale'];
  if (typeof legalName !== 'string' || typeof rationale !== 'string') {
    return null;
  }
  const out: CreateCompanyPayload = { legalName, rationale };
  if (typeof proposedPayload['domain'] === 'string') {
    out.domain = proposedPayload['domain'] as string;
  }
  if (typeof proposedPayload['industry'] === 'string') {
    out.industry = proposedPayload['industry'] as string;
  }
  return out;
}

export async function applyCreateCompany(
  approvalId: string,
  payload: CreateCompanyPayload,
): Promise<ExecutorResult> {
  if (await alreadyApplied(approvalId)) return { ok: true };
  const id = createId();
  await db.insert(organizations).values({
    id,
    legalName: payload.legalName,
    domain: payload.domain ?? null,
    industry: payload.industry ?? null,
    status: 'active',
  });
  await stampApplied(approvalId, id, 'organization.created', {
    legal_name: payload.legalName,
  });
  return { ok: true, appliedObjectId: id };
}

// ============================================================================
// crm.create_contact
// ============================================================================

export interface CreateContactPayload {
  fullName: string;
  title?: string;
  emails?: string[];
  phones?: string[];
  orgs: Array<{ orgId: string; role?: string; isPrimary?: boolean }>;
  rationale: string;
}

export function parseCreateContactPayload(
  proposedPayload: Record<string, unknown> | null | undefined,
): CreateContactPayload | null {
  if (!proposedPayload || typeof proposedPayload !== 'object') return null;
  const fullName = proposedPayload['fullName'];
  const orgs = proposedPayload['orgs'];
  const rationale = proposedPayload['rationale'];
  if (
    typeof fullName !== 'string' ||
    !Array.isArray(orgs) ||
    orgs.length === 0 ||
    typeof rationale !== 'string'
  ) {
    return null;
  }
  const out: CreateContactPayload = {
    fullName,
    orgs: orgs as CreateContactPayload['orgs'],
    rationale,
  };
  if (typeof proposedPayload['title'] === 'string') {
    out.title = proposedPayload['title'] as string;
  }
  if (Array.isArray(proposedPayload['emails'])) {
    out.emails = proposedPayload['emails'] as string[];
  }
  if (Array.isArray(proposedPayload['phones'])) {
    out.phones = proposedPayload['phones'] as string[];
  }
  return out;
}

export async function applyCreateContact(
  approvalId: string,
  payload: CreateContactPayload,
): Promise<ExecutorResult> {
  if (await alreadyApplied(approvalId)) return { ok: true };
  const id = createId();
  const primaryOrg =
    payload.orgs.find((o) => o.isPrimary) ?? payload.orgs[0]!;
  await db.insert(contacts).values({
    id,
    orgId: primaryOrg.orgId,
    fullName: payload.fullName,
    title: payload.title ?? null,
    emails: (payload.emails ?? []).map((e) => e.toLowerCase()),
    phones: payload.phones ?? [],
    status: 'active',
  });
  for (const link of payload.orgs) {
    await db
      .insert(contactOrgMemberships)
      .values({
        contactId: id,
        orgId: link.orgId,
        role: link.role ?? null,
        isPrimary:
          (link.isPrimary ?? false) || link.orgId === primaryOrg.orgId,
      })
      .onConflictDoNothing();
  }
  await stampApplied(approvalId, id, 'contact.created', {
    full_name: payload.fullName,
  });
  return { ok: true, appliedObjectId: id };
}

// ============================================================================
// lead.close
// ============================================================================

export interface CloseLeadPayload {
  leadId: string;
  outcome: 'won' | 'lost';
  reason: string;
}

export function parseCloseLeadPayload(
  proposedPayload: Record<string, unknown> | null | undefined,
): CloseLeadPayload | null {
  if (!proposedPayload || typeof proposedPayload !== 'object') return null;
  const leadId = proposedPayload['leadId'];
  const outcome = proposedPayload['outcome'];
  const reason = proposedPayload['reason'];
  if (
    typeof leadId !== 'string' ||
    (outcome !== 'won' && outcome !== 'lost') ||
    typeof reason !== 'string'
  ) {
    return null;
  }
  return { leadId, outcome: outcome as 'won' | 'lost', reason };
}

export async function applyCloseLead(
  approvalId: string,
  payload: CloseLeadPayload,
): Promise<ExecutorResult> {
  if (await alreadyApplied(approvalId)) return { ok: true };
  await db
    .update(leads)
    .set({ status: payload.outcome })
    .where(eq(leads.id, payload.leadId));
  await stampApplied(approvalId, payload.leadId, `lead.${payload.outcome}`, {
    reason: payload.reason,
  });
  return { ok: true, appliedObjectId: payload.leadId };
}

// ============================================================================
// follow_up.schedule
// ============================================================================

export interface ScheduleFollowUpPayload {
  title: string;
  note?: string;
  dueAt: string; // ISO-8601 UTC
  subjectType?: string;
  subjectId?: string;
  assignedTo?: string;
  rationale?: string;
}

export function parseScheduleFollowUpPayload(
  proposedPayload: Record<string, unknown> | null | undefined,
): ScheduleFollowUpPayload | null {
  if (!proposedPayload || typeof proposedPayload !== 'object') return null;
  const title = proposedPayload['title'];
  const dueAt = proposedPayload['dueAt'];
  if (typeof title !== 'string' || typeof dueAt !== 'string') return null;
  const out: ScheduleFollowUpPayload = { title, dueAt };
  if (typeof proposedPayload['note'] === 'string') {
    out.note = proposedPayload['note'] as string;
  }
  if (typeof proposedPayload['subjectType'] === 'string') {
    out.subjectType = proposedPayload['subjectType'] as string;
  }
  if (typeof proposedPayload['subjectId'] === 'string') {
    out.subjectId = proposedPayload['subjectId'] as string;
  }
  if (typeof proposedPayload['assignedTo'] === 'string') {
    out.assignedTo = proposedPayload['assignedTo'] as string;
  }
  return out;
}

export async function applyScheduleFollowUp(
  approvalId: string,
  payload: ScheduleFollowUpPayload,
  reviewerId: string | null,
): Promise<ExecutorResult> {
  if (await alreadyApplied(approvalId)) return { ok: true };
  const id = createId();
  await db.insert(followUps).values({
    id,
    title: payload.title,
    note: payload.note ?? null,
    dueAt: new Date(payload.dueAt),
    subjectType: payload.subjectType ?? null,
    subjectId: payload.subjectId ?? null,
    assignedTo: payload.assignedTo ?? null,
    createdBy: reviewerId ?? 'system',
    status: 'open',
  });
  await stampApplied(approvalId, id, 'follow_up.scheduled', {
    title: payload.title,
  });
  return { ok: true, appliedObjectId: id };
}

// ============================================================================
// org.set_kind / org.add_product / org.tag / org.untag / org.link_relationship
// org.update_fields / contact.tag / contact.untag / contact.opt_out
// ============================================================================

export async function applyOrgSetKind(
  approvalId: string,
  payload: { orgId: string; orgKind: string },
): Promise<ExecutorResult> {
  if (await alreadyApplied(approvalId)) return { ok: true };
  await db
    .update(organizations)
    .set({ kind: payload.orgKind })
    .where(eq(organizations.id, payload.orgId));
  await stampApplied(approvalId, payload.orgId, 'organization.kind_set', {
    kind: payload.orgKind,
  });
  return { ok: true, appliedObjectId: payload.orgId };
}

export async function applyOrgAddProduct(
  approvalId: string,
  payload: { orgId: string; product: string; notes?: string },
  reviewerId: string | null,
): Promise<ExecutorResult> {
  if (await alreadyApplied(approvalId)) return { ok: true };
  const id = createId();
  await db
    .insert(organizationProducts)
    .values({
      id,
      orgId: payload.orgId,
      product: payload.product,
      notes: payload.notes ?? null,
      addedBy: reviewerId ?? 'system',
    })
    .onConflictDoNothing();
  await stampApplied(approvalId, id, 'organization.product_added', {
    org_id: payload.orgId,
    product: payload.product,
  });
  return { ok: true, appliedObjectId: id };
}

export async function applyOrgLinkRelationship(
  approvalId: string,
  payload: {
    fromOrgId: string;
    toOrgId: string;
    relationshipType: string;
    product?: string;
  },
  reviewerId: string | null,
): Promise<ExecutorResult> {
  if (await alreadyApplied(approvalId)) return { ok: true };
  const id = createId();
  await db.insert(organizationRelationships).values({
    id,
    fromOrgId: payload.fromOrgId,
    toOrgId: payload.toOrgId,
    relationshipType: payload.relationshipType,
    product: payload.product ?? null,
    addedBy: reviewerId ?? 'system',
  });
  await stampApplied(approvalId, id, 'organization.relationship_linked', {
    from_org_id: payload.fromOrgId,
    to_org_id: payload.toOrgId,
    type: payload.relationshipType,
  });
  return { ok: true, appliedObjectId: id };
}

/**
 * Append/remove a tag in a JSONB array. Idempotent — if the tag is
 * already present (resp. absent) the update is a no-op.
 */
async function tagOp(
  table: 'organizations' | 'contacts',
  rowId: string,
  tag: string,
  op: 'add' | 'remove',
): Promise<void> {
  if (table === 'organizations') {
    if (op === 'add') {
      await db.execute(
        sql`UPDATE organizations
            SET tags = COALESCE(tags, '[]'::jsonb) || ${JSON.stringify([tag])}::jsonb
            WHERE id = ${rowId} AND NOT (tags @> ${JSON.stringify([tag])}::jsonb)`,
      );
    } else {
      await db.execute(
        sql`UPDATE organizations
            SET tags = (
              SELECT COALESCE(jsonb_agg(t), '[]'::jsonb)
              FROM jsonb_array_elements_text(tags) AS t
              WHERE t <> ${tag}
            )
            WHERE id = ${rowId}`,
      );
    }
  } else {
    if (op === 'add') {
      await db.execute(
        sql`UPDATE contacts
            SET tags = COALESCE(tags, '[]'::jsonb) || ${JSON.stringify([tag])}::jsonb
            WHERE id = ${rowId} AND NOT (tags @> ${JSON.stringify([tag])}::jsonb)`,
      );
    } else {
      await db.execute(
        sql`UPDATE contacts
            SET tags = (
              SELECT COALESCE(jsonb_agg(t), '[]'::jsonb)
              FROM jsonb_array_elements_text(tags) AS t
              WHERE t <> ${tag}
            )
            WHERE id = ${rowId}`,
      );
    }
  }
}

export async function applyOrgTag(
  approvalId: string,
  payload: { orgId: string; tag: string },
  op: 'add' | 'remove',
): Promise<ExecutorResult> {
  if (await alreadyApplied(approvalId)) return { ok: true };
  await tagOp('organizations', payload.orgId, payload.tag, op);
  await stampApplied(
    approvalId,
    payload.orgId,
    op === 'add' ? 'organization.tagged' : 'organization.untagged',
    { tag: payload.tag },
  );
  return { ok: true, appliedObjectId: payload.orgId };
}

export async function applyContactTag(
  approvalId: string,
  payload: { contactId: string; tag: string },
  op: 'add' | 'remove',
): Promise<ExecutorResult> {
  if (await alreadyApplied(approvalId)) return { ok: true };
  await tagOp('contacts', payload.contactId, payload.tag, op);
  await stampApplied(
    approvalId,
    payload.contactId,
    op === 'add' ? 'contact.tagged' : 'contact.untagged',
    { tag: payload.tag },
  );
  return { ok: true, appliedObjectId: payload.contactId };
}

export async function applyContactOptOut(
  approvalId: string,
  payload: { contactId: string; reason: string },
): Promise<ExecutorResult> {
  if (await alreadyApplied(approvalId)) return { ok: true };
  await db
    .update(contacts)
    .set({
      optOutAt: new Date(),
      optOutReason: payload.reason,
    })
    .where(eq(contacts.id, payload.contactId));
  await stampApplied(approvalId, payload.contactId, 'contact.opted_out', {
    reason: payload.reason,
  });
  return { ok: true, appliedObjectId: payload.contactId };
}

export async function applyOrgUpdateFields(
  approvalId: string,
  payload: {
    orgId: string;
    patch: { domain?: string | null; industry?: string | null; country?: string | null };
  },
): Promise<ExecutorResult> {
  if (await alreadyApplied(approvalId)) return { ok: true };
  const updates: Record<string, unknown> = {};
  if (payload.patch.domain !== undefined) {
    updates['domain'] = payload.patch.domain;
  }
  if (payload.patch.industry !== undefined) {
    updates['industry'] = payload.patch.industry;
  }
  if (payload.patch.country !== undefined) {
    // country lives inside the geo jsonb.
    if (payload.patch.country == null) {
      // best-effort: clear geo.country only
      await db.execute(
        sql`UPDATE organizations SET geo = COALESCE(geo, '{}'::jsonb) - 'country' WHERE id = ${payload.orgId}`,
      );
    } else {
      await db.execute(
        sql`UPDATE organizations SET geo = COALESCE(geo, '{}'::jsonb) || ${JSON.stringify({ country: payload.patch.country })}::jsonb WHERE id = ${payload.orgId}`,
      );
    }
  }
  if (Object.keys(updates).length > 0) {
    await db.update(organizations).set(updates).where(eq(organizations.id, payload.orgId));
  }
  await stampApplied(approvalId, payload.orgId, 'organization.fields_updated', {
    keys: Object.keys(updates),
    changed_country: payload.patch.country !== undefined,
  });
  return { ok: true, appliedObjectId: payload.orgId };
}

