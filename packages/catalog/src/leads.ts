import 'server-only';
import { and, desc, eq, sql } from 'drizzle-orm';
import {
  contactOrgMemberships,
  contacts,
  db,
  leads,
  organizations,
} from '@procur/db';
import { createId } from '@procur/ai';

/**
 * In-process replacement for the vex-into-procur-merge brief Phase 4
 * "qualify-as-lead" path. Replaces the deleted apps/app/lib/vex-client.ts
 * `pushVexContact` HTTP call with a direct DB write into procur's own
 * `organizations` + `contacts` + `contact_org_memberships` + `leads`
 * tables (Phase 1 schema).
 *
 * Idempotent on `lead_external_keys.procur_source_ref` — re-pushing
 * the same `sourceRef` resolves to the existing lead.
 *
 * Returns `{ leadId, orgId, contactId?, leadUrl, dedupedAgainstExisting }`
 * so callers (match queue, entity profile, assistant apply) can
 * navigate to /leads/[id] after the call.
 */

import type { LeadProcurMetadata } from '@procur/db';
import type { Lead } from '@procur/db';

export interface QualifyAsLeadInput {
  /** Source identifier — match-queue:<id>:<canonicalKey>, entity:<slug>,
   *  assistant:<threadId>:<turnIdx>. Used as the dedup key. */
  sourceRef: string;
  /** Triggering surface for the originationContext audit trail. */
  triggeredBy: string;

  /** Identity. */
  legalName: string;
  country: string | null;
  domain: string | null;
  /** Counterparty role hint: buyer, supplier, broker, etc. */
  role: string | null;

  /** Optional contact — when present we create/find a contacts row
   *  and a memberships row linking to the org. */
  contact: {
    name: string | null;
    email: string | null;
    phone: string | null;
    title: string | null;
    linkedinUrl: string | null;
  } | null;

  /** Free-text chat summary + user note for the lead's audit trail. */
  chatSummary: string | null;
  userNote: string | null;

  /** Procur-side metadata that lands on leads.procur_metadata
   *  jsonb (Phase 1 schema). The shape mirrors the brief's
   *  LeadProcurMetadata interface — every sub-field is optional. */
  procurMetadata: LeadProcurMetadata;
}

export interface QualifyAsLeadResult {
  leadId: string;
  orgId: string;
  contactId: string | null;
  leadUrl: string;
  dedupedAgainstExisting: boolean;
}

/** Resolve or create the org row; idempotent on (domain) when present
 *  else on (legal_name, country). */
async function resolveOrg(input: {
  legalName: string;
  country: string | null;
  domain: string | null;
  role: string | null;
}): Promise<{ id: string; created: boolean }> {
  if (input.domain) {
    const byDomain = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.domain, input.domain))
      .limit(1);
    if (byDomain[0]) return { id: byDomain[0].id, created: false };
  }
  // Fall back to legal_name + country (case-insensitive name match).
  const byName = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(
      and(
        sql`lower(${organizations.legalName}) = lower(${input.legalName})`,
        input.country
          ? sql`(${organizations.geo}->>'country') = ${input.country}`
          : sql`true`,
      ),
    )
    .limit(1);
  if (byName[0]) return { id: byName[0].id, created: false };

  // Create new org.
  const id = createId();
  await db.insert(organizations).values({
    id,
    legalName: input.legalName,
    domain: input.domain ?? null,
    geo: input.country ? { country: input.country } : null,
    kind: input.role ?? null,
    status: 'active',
  });
  return { id, created: true };
}

/** Resolve or create a contact row + membership. Returns null when no
 *  contact details were provided. */
async function resolveContact(
  orgId: string,
  contact: NonNullable<QualifyAsLeadInput['contact']>,
): Promise<string | null> {
  if (!contact.name && !contact.email && !contact.phone) return null;

  // Match by email first if present (most reliable).
  if (contact.email) {
    const lowered = contact.email.toLowerCase();
    const existing = await db
      .select({ id: contacts.id })
      .from(contacts)
      .where(sql`${contacts.emails} @> ${JSON.stringify([lowered])}::jsonb`)
      .limit(1);
    if (existing[0]) {
      // Ensure the membership exists (idempotent on PK).
      await db
        .insert(contactOrgMemberships)
        .values({
          contactId: existing[0].id,
          orgId,
          isPrimary: false,
        })
        .onConflictDoNothing();
      return existing[0].id;
    }
  }

  const id = createId();
  const emails = contact.email ? [contact.email.toLowerCase()] : [];
  const phones = contact.phone ? [contact.phone] : [];
  await db.insert(contacts).values({
    id,
    orgId,
    fullName: contact.name ?? '(unknown)',
    title: contact.title,
    emails,
    phones,
    status: 'active',
    externalKeys: contact.linkedinUrl
      ? { linkedin: contact.linkedinUrl }
      : {},
  });
  await db.insert(contactOrgMemberships).values({
    contactId: id,
    orgId,
    isPrimary: true,
  });
  return id;
}

/** Find an existing lead with the given source_ref stored in
 *  external_keys.procur_source_ref, returning its id when present. */
async function findExistingBySourceRef(
  sourceRef: string,
): Promise<string | null> {
  const rows = await db
    .select({ id: leads.id })
    .from(leads)
    .where(
      sql`${leads.externalKeys} @> ${JSON.stringify({ procur_source_ref: sourceRef })}::jsonb`,
    )
    .orderBy(desc(leads.createdAt))
    .limit(1);
  return rows[0]?.id ?? null;
}

const APP_URL =
  process.env.NEXT_PUBLIC_APP_URL ?? 'https://app.procur.app';

export async function qualifyAsLead(
  input: QualifyAsLeadInput,
): Promise<QualifyAsLeadResult> {
  // Idempotency: reuse the existing lead row if this sourceRef already
  // landed once. The caller usually re-pushes when a contact field is
  // updated; we don't fork a new lead in that case.
  const existingLeadId = await findExistingBySourceRef(input.sourceRef);
  if (existingLeadId) {
    const existing = await db
      .select({ orgId: leads.orgId, contactId: leads.contactId })
      .from(leads)
      .where(eq(leads.id, existingLeadId))
      .limit(1);
    if (existing[0]) {
      return {
        leadId: existingLeadId,
        orgId: existing[0].orgId,
        contactId: existing[0].contactId ?? null,
        leadUrl: `${APP_URL}/leads/${existingLeadId}`,
        dedupedAgainstExisting: true,
      };
    }
  }

  const org = await resolveOrg({
    legalName: input.legalName,
    country: input.country,
    domain: input.domain,
    role: input.role,
  });

  const contactId = input.contact
    ? await resolveContact(org.id, input.contact)
    : null;

  const leadId = createId();
  await db.insert(leads).values({
    id: leadId,
    orgId: org.id,
    contactId,
    status: 'new',
    qualificationSummary: input.chatSummary ?? null,
    externalKeys: {
      procur_source_ref: input.sourceRef,
    },
    procurMetadata: {
      ...input.procurMetadata,
      pushReason:
        input.procurMetadata.pushReason ?? input.userNote ?? undefined,
    },
  });

  return {
    leadId,
    orgId: org.id,
    contactId,
    leadUrl: `${APP_URL}/leads/${leadId}`,
    dedupedAgainstExisting: false,
  };
}

// ============================================================================
// Read helpers — power the /leads UI surfaces
// ============================================================================

export interface LeadListRow {
  id: string;
  orgId: string;
  orgLegalName: string;
  contactId: string | null;
  contactFullName: string | null;
  status: 'new' | 'qualified' | 'disqualified' | 'won' | 'lost';
  stage: string | null;
  qualificationSummary: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export async function listLeads(
  options: { limit?: number; status?: LeadListRow['status'] } = {},
): Promise<LeadListRow[]> {
  const limit = options.limit ?? 50;
  const rows = await db
    .select({
      id: leads.id,
      orgId: leads.orgId,
      orgLegalName: organizations.legalName,
      contactId: leads.contactId,
      contactFullName: contacts.fullName,
      status: leads.status,
      stage: leads.stage,
      qualificationSummary: leads.qualificationSummary,
      createdAt: leads.createdAt,
      updatedAt: leads.updatedAt,
    })
    .from(leads)
    .leftJoin(organizations, eq(organizations.id, leads.orgId))
    .leftJoin(contacts, eq(contacts.id, leads.contactId))
    .where(options.status ? eq(leads.status, options.status) : undefined)
    .orderBy(desc(leads.createdAt))
    .limit(limit);
  return rows.map((r) => ({
    id: r.id,
    orgId: r.orgId,
    orgLegalName: r.orgLegalName ?? '(missing)',
    contactId: r.contactId,
    contactFullName: r.contactFullName,
    status: r.status,
    stage: r.stage,
    qualificationSummary: r.qualificationSummary,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }));
}

export interface LeadDetail {
  lead: Lead;
  org: { id: string; legalName: string; domain: string | null } | null;
  contact: { id: string; fullName: string; emails: string[] } | null;
}

export async function getLead(id: string): Promise<LeadDetail | null> {
  const rows = await db
    .select({
      lead: leads,
      org: {
        id: organizations.id,
        legalName: organizations.legalName,
        domain: organizations.domain,
      },
      contact: {
        id: contacts.id,
        fullName: contacts.fullName,
        emails: contacts.emails,
      },
    })
    .from(leads)
    .leftJoin(organizations, eq(organizations.id, leads.orgId))
    .leftJoin(contacts, eq(contacts.id, leads.contactId))
    .where(eq(leads.id, id))
    .limit(1);
  if (!rows[0]) return null;
  const r = rows[0];
  return {
    lead: r.lead as Lead,
    org: r.org && r.org.id ? r.org : null,
    contact:
      r.contact && r.contact.id
        ? {
            id: r.contact.id,
            fullName: r.contact.fullName,
            emails: (r.contact.emails as string[] | null) ?? [],
          }
        : null,
  };
}
