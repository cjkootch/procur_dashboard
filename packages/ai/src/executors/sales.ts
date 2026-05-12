import { eq, sql } from 'drizzle-orm';
import {
  approvals,
  contactOrgMemberships,
  contacts,
  db,
  events,
  followUps,
  knownEntities,
  leads,
  organizationProducts,
  organizationRelationships,
  organizations,
} from '@procur/db';
import { createId } from '../agents/id';
import {
  emitOutreachOutcome,
  findRecentOutreachApprovalsByContact,
} from './outreach-evidence';

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
  /** Each org link supplies orgId OR knownEntitySlug; the executor
   *  resolves the slug to (or creates) an organizations row before
   *  inserting the contact. */
  orgs: Array<{
    orgId?: string;
    knownEntitySlug?: string;
    role?: string;
    isPrimary?: boolean;
  }>;
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
  // Validate each org link has at least one of orgId / knownEntitySlug.
  const validatedOrgs: CreateContactPayload['orgs'] = [];
  for (const raw of orgs) {
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as Record<string, unknown>;
    const orgId = typeof r['orgId'] === 'string' ? (r['orgId'] as string) : undefined;
    const knownEntitySlug =
      typeof r['knownEntitySlug'] === 'string'
        ? (r['knownEntitySlug'] as string)
        : undefined;
    if (!orgId && !knownEntitySlug) return null;
    validatedOrgs.push({
      ...(orgId ? { orgId } : {}),
      ...(knownEntitySlug ? { knownEntitySlug } : {}),
      ...(typeof r['role'] === 'string' ? { role: r['role'] as string } : {}),
      ...(typeof r['isPrimary'] === 'boolean'
        ? { isPrimary: r['isPrimary'] as boolean }
        : {}),
    });
  }

  const out: CreateContactPayload = {
    fullName,
    orgs: validatedOrgs,
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

export type InsertContactResult =
  | {
      ok: true;
      contactId: string;
      primaryOrgId: string;
      dedupedAgainstExisting?: { contactId: string };
    }
  | { ok: false; error: string };

/**
 * Insert a single contact row + its org-membership links, resolving
 * each org link to a concrete organizations.id (creating shadow CRM
 * orgs from rolodex slugs as needed).
 *
 * Exported so the chat-side auto-add tool (`add_contacts`) shares the
 * same write path as the approval-applied propose flow — both produce
 * identical CRM rows. No approval-id concerns; caller (executor vs.
 * chat tool) handles their own idempotency.
 *
 * Dedup discipline: when `dedupBy === 'fullNameAndPrimaryOrg'`, skip
 * insert if an active contact with the same fullName under the same
 * resolved primary org already exists. Returns the existing contactId
 * in that case. The contacts table has no unique constraint at the
 * DB level — dedup is app-side, by design (same person legitimately
 * appears under multiple org variants).
 */
export async function insertContactRow(
  payload: CreateContactPayload,
  options: { dedupBy?: 'fullNameAndPrimaryOrg' | 'none'; tags?: string[] } = {},
): Promise<InsertContactResult> {
  const dedupBy = options.dedupBy ?? 'none';
  const extraTags = options.tags ?? [];

  const resolved: Array<{
    orgId: string;
    role: string | null;
    isPrimary: boolean;
  }> = [];
  for (const link of payload.orgs) {
    const orgId =
      link.orgId ??
      (link.knownEntitySlug
        ? await resolveOrCreateOrgFromKnownEntity(link.knownEntitySlug)
        : null);
    if (!orgId) {
      return {
        ok: false,
        error: `Could not resolve org link (orgId=${link.orgId ?? 'null'}, slug=${link.knownEntitySlug ?? 'null'})`,
      };
    }
    resolved.push({
      orgId,
      role: link.role ?? null,
      isPrimary: link.isPrimary ?? false,
    });
  }

  const primary = resolved.find((o) => o.isPrimary) ?? resolved[0]!;

  if (dedupBy === 'fullNameAndPrimaryOrg') {
    const existing = await db
      .select({ id: contacts.id })
      .from(contacts)
      .where(
        sql`${contacts.orgId} = ${primary.orgId}
            AND LOWER(${contacts.fullName}) = LOWER(${payload.fullName})
            AND ${contacts.status} = 'active'
            AND ${contacts.mergedIntoContactId} IS NULL`,
      )
      .limit(1);
    if (existing[0]?.id) {
      return {
        ok: true,
        contactId: existing[0].id,
        primaryOrgId: primary.orgId,
        dedupedAgainstExisting: { contactId: existing[0].id },
      };
    }
  }

  const id = createId();
  await db.insert(contacts).values({
    id,
    orgId: primary.orgId,
    fullName: payload.fullName,
    title: payload.title ?? null,
    emails: (payload.emails ?? []).map((e) => e.toLowerCase()),
    phones: payload.phones ?? [],
    tags: extraTags,
    status: 'active',
  });
  for (const link of resolved) {
    await db
      .insert(contactOrgMemberships)
      .values({
        contactId: id,
        orgId: link.orgId,
        role: link.role,
        isPrimary: link.isPrimary || link.orgId === primary.orgId,
      })
      .onConflictDoNothing();
  }

  return { ok: true, contactId: id, primaryOrgId: primary.orgId };
}

export async function applyCreateContact(
  approvalId: string,
  payload: CreateContactPayload,
): Promise<ExecutorResult> {
  if (await alreadyApplied(approvalId)) return { ok: true };

  const result = await insertContactRow(payload);
  if (!result.ok) {
    return { ok: false, error: result.error };
  }
  await stampApplied(approvalId, result.contactId, 'contact.created', {
    full_name: payload.fullName,
  });
  return { ok: true, appliedObjectId: result.contactId };
}

/**
 * Look up an organizations row carrying the given known_entity slug
 * in its external_keys.known_entity_slug; create one on demand from
 * the entity's curated metadata when no shadow row exists yet.
 *
 * The shadow org isn't a duplicate of the rolodex entity — it's the
 * CRM-side handle the agent runtime, sales pipeline, and outreach
 * tools need. The known_entity slug is preserved in external_keys
 * so future writes find the same row instead of creating a dupe.
 */
/**
 * Resolve a known_entities slug to a CRM organizations ULID, creating
 * a shadow CRM org from the rolodex entity if one doesn't exist yet.
 * Used by chat propose-* flows where the operator points at a rolodex
 * entity by slug and the executor needs to land a write on a
 * CRM-shaped row (organizations / leads / deals / etc.).
 *
 * Exported so other executors (deals.ts, etc.) can reuse the same
 * resolver. Returns null when the slug doesn't resolve to a known
 * entity at all — caller decides whether to fail or fall back.
 */
export async function resolveOrCreateOrgFromKnownEntity(
  slug: string,
): Promise<string | null> {
  // Existing org with this slug already wired up?
  const existing = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(sql`${organizations.externalKeys} ->> 'known_entity_slug' = ${slug}`)
    .limit(1);
  if (existing[0]?.id) return existing[0].id;

  // Create a shadow CRM org from the rolodex entity's data.
  const entity = await db
    .select({
      slug: knownEntities.slug,
      name: knownEntities.name,
      country: knownEntities.country,
      role: knownEntities.role,
    })
    .from(knownEntities)
    .where(eq(knownEntities.slug, slug))
    .limit(1);
  if (!entity[0]) return null;

  const id = createId();
  await db.insert(organizations).values({
    id,
    legalName: entity[0].name,
    domain: null,
    industry: entity[0].role ?? null,
    geo: entity[0].country ? { country: entity[0].country } : null,
    externalKeys: { known_entity_slug: slug },
    sourceOfTruth: 'known_entity',
    status: 'active',
  });
  return id;
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
  // Pull contactId before the update so the lead row still has it on
  // hand for the disqualified attribution below — closes are typically
  // 'lost' but we read regardless.
  const leadRow = await db
    .select({ contactId: leads.contactId })
    .from(leads)
    .where(eq(leads.id, payload.leadId))
    .limit(1);
  const contactId = leadRow[0]?.contactId ?? null;

  await db
    .update(leads)
    .set({ status: payload.outcome })
    .where(eq(leads.id, payload.leadId));
  await stampApplied(approvalId, payload.leadId, `lead.${payload.outcome}`, {
    reason: payload.reason,
  });

  // Outreach lifecycle: lost leads with a known contact attribute
  // back to the originating outreach approvals so the dashboard can
  // compute true negative-outcome rates per pipeline rev.
  if (payload.outcome === 'lost' && contactId) {
    const recent = await findRecentOutreachApprovalsByContact(contactId);
    for (const originatingApproval of recent) {
      await emitOutreachOutcome({
        approvalId: originatingApproval,
        verb: 'outreach.disqualified',
        occurredAt: new Date(),
        objectId: payload.leadId,
        objectType: 'lead',
        metadata: {
          reason: 'lead_lost',
          lead_close_reason: payload.reason,
          triggered_by_approval: approvalId,
        },
      });
    }
  }

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

  // Outreach lifecycle: every recent comm approval (last 30d) that
  // targeted this contact gets `outreach.disqualified`. Powers the
  // Match Performance Dashboard's negative-outcome column. Idempotent
  // on (originatingApproval, verb).
  const recent = await findRecentOutreachApprovalsByContact(payload.contactId);
  for (const originatingApproval of recent) {
    await emitOutreachOutcome({
      approvalId: originatingApproval,
      verb: 'outreach.disqualified',
      occurredAt: new Date(),
      objectId: payload.contactId,
      objectType: 'contact',
      metadata: {
        reason: 'contact_opted_out',
        opt_out_reason: payload.reason,
        triggered_by_approval: approvalId,
      },
    });
  }

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

