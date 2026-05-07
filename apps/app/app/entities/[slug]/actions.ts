'use server';

import { revalidatePath } from 'next/cache';
import { requireCompany } from '@procur/auth';
import {
  SupplierApprovalEntityMissingError,
  resolveApolloEntityRef,
  upsertSupplierApproval,
} from '@procur/catalog';
import {
  isSupplierApprovalStatus,
  type SupplierApprovalStatus,
} from '@procur/db';
import {
  enrichOrgFromApollo,
  enrichOrgsBatch,
  enrichPerson,
  searchPeople,
  type ApolloDegradeResult,
  type ApolloPeopleSearchFilters,
  type ApolloSeniority,
} from '@procur/apollo';

export type SetSupplierApprovalInput = {
  entitySlug: string;
  entityName?: string | null;
  status: SupplierApprovalStatus;
  expiresAt?: string | null;
  notes?: string | null;
};

/**
 * Server action invoked from the entity profile page approval form.
 * Validates status against the enum and writes via the shared
 * upsert helper.
 */
export async function setSupplierApprovalAction(
  input: SetSupplierApprovalInput,
): Promise<void> {
  const { company, user } = await requireCompany();
  if (!isSupplierApprovalStatus(input.status)) {
    throw new Error(`Invalid supplier approval status: ${input.status}`);
  }
  let expiresAt: Date | null = null;
  if (input.expiresAt) {
    const parsed = new Date(input.expiresAt);
    if (Number.isNaN(parsed.getTime())) {
      throw new Error(`Invalid expiresAt date: ${input.expiresAt}`);
    }
    expiresAt = parsed;
  }
  try {
    await upsertSupplierApproval({
      companyId: company.id,
      userId: user.id,
      entitySlug: input.entitySlug,
      entityName: input.entityName ?? null,
      status: input.status,
      expiresAt,
      notes: input.notes ?? null,
    });
  } catch (err) {
    // The form lives on the entity profile page so the slug
    // SHOULD resolve. If we hit the missing-entity guard it means
    // someone hand-crafted the slug or a stale form is in flight;
    // either way, re-throwing as a plain Error keeps the standard
    // server-action error boundary path.
    if (err instanceof SupplierApprovalEntityMissingError) {
      throw new Error(err.message);
    }
    throw err;
  }
  revalidatePath(`/entities/${input.entitySlug}`);
  revalidatePath('/suppliers/known-entities');
  revalidatePath('/settings');
}

// ─── Apollo actions (Day 5b per apollo-integration-brief.md §6.4-6.5) ──

export type ApolloActionResult =
  | { ok: true; message: string }
  | { ok: false; reason: string; message: string };

/**
 * enrichApolloPersonAction result. Strict superset of ApolloActionResult
 * — adds the resolved-person record on success so chat-side callers
 * can swap the obfuscated row inline without re-fetching. Existing
 * UI callers that only check `ok` keep working unchanged.
 */
export type EnrichApolloPersonActionResult =
  | {
      ok: true;
      message: string;
      person: {
        apolloPersonId: string;
        firstName: string;
        lastName: string;
        title: string | null;
        email: string | null;
        directPhone: string | null;
        linkedinUrl: string | null;
      };
    }
  | { ok: false; reason: string; message: string };

function degradeMessage(reason: ApolloDegradeResult['reason']): string {
  switch (reason) {
    case 'feature-flag-disabled':
      return 'Apollo integration is disabled in this environment.';
    case 'no-master-key':
      return 'Apollo master API key is not configured.';
    case 'rate-limited-internally':
      return 'Apollo rate limit reached. Try again in a few minutes.';
    case 'apollo-403':
      return 'Apollo denied the request (master key required for this endpoint).';
    case 'apollo-422':
      return 'Apollo rejected the request as invalid.';
    case 'apollo-429':
      return 'Apollo rate limit reached after retries. Try again later.';
    case 'apollo-401':
      return 'Apollo credentials are invalid.';
    case 'apollo-no-match':
      return 'Apollo has no matching record.';
    case 'apollo-transport-error':
      return 'Could not reach Apollo. Try again.';
    case 'tenant-daily-enrichment-cap-reached':
      return 'Daily enrichment cap reached for your team. Resets in 24 hours.';
    case 'unconfirmed-bulk-enrichment':
      return 'Bulk enrichment requires explicit confirmation.';
    default:
      return `Apollo call failed (${reason}).`;
  }
}

/**
 * Refresh the Apollo cache for an entity. Two-stage flow:
 *  1. If apollo_org_id is unknown but primary_domain is set → call
 *     enrichOrgsBatch (single-domain) to match-and-cache the thin
 *     snapshot.
 *  2. If apollo_org_id is known → call enrichOrgFromApollo with
 *     freshnessHours=0 to force a fresh single-get and write the
 *     full snapshot.
 *
 * Pre-existing matches with no domain return a degrade — there's
 * nothing to refresh from.
 */
export async function refreshApolloOrgAction(input: {
  entitySlug: string;
}): Promise<ApolloActionResult> {
  await requireCompany();
  const ref = await resolveApolloEntityRef(input.entitySlug);
  if (!ref) {
    return { ok: false, reason: 'entity-not-found', message: 'Entity not found.' };
  }

  if (ref.apolloOrgId) {
    const result = await enrichOrgFromApollo({
      apolloOrgId: ref.apolloOrgId,
      target: { table: ref.table, id: ref.rowId },
      freshnessHours: 0,
    });
    if ('ok' in result && result.ok === false) {
      return { ok: false, reason: result.reason, message: degradeMessage(result.reason) };
    }
    revalidatePath(`/entities/${input.entitySlug}`);
    return { ok: true, message: 'Apollo snapshot refreshed.' };
  }

  if (!ref.primaryDomain) {
    return {
      ok: false,
      reason: 'no-domain',
      message: 'Set the entity primary domain to enable Apollo matching.',
    };
  }

  const result = await enrichOrgsBatch({
    domains: [ref.primaryDomain],
    targetTable: ref.table,
  });
  if ('ok' in result && result.ok === false) {
    return { ok: false, reason: result.reason, message: degradeMessage(result.reason) };
  }
  if ('matched' in result && result.matched > 0) {
    revalidatePath(`/entities/${input.entitySlug}`);
    revalidatePath('/suppliers/known-entities');
    return { ok: true, message: 'Matched in Apollo. Refresh again for the full snapshot.' };
  }
  return {
    ok: false,
    reason: 'apollo-no-match',
    message: `No Apollo match for ${ref.primaryDomain}.`,
  };
}

/**
 * Resolve an Apollo person's email + direct phone + full last name.
 * Paid call, gated by per-tenant per-day cap. Updates the existing
 * pre-enrichment row in entity_contact_enrichments in place.
 */
export async function enrichApolloPersonAction(input: {
  entitySlug: string;
  apolloPersonId: string;
}): Promise<EnrichApolloPersonActionResult> {
  const { company } = await requireCompany();
  const result = await enrichPerson({
    apolloPersonId: input.apolloPersonId,
    entitySlug: input.entitySlug,
    companyId: company.id,
  });
  if ('ok' in result && result.ok === false) {
    return { ok: false, reason: result.reason, message: degradeMessage(result.reason) };
  }
  revalidatePath(`/entities/${input.entitySlug}`);
  return {
    ok: true,
    message: `Enriched ${result.full.firstName} ${result.full.lastName}.`,
    person: {
      apolloPersonId: result.full.id,
      firstName: result.full.firstName,
      lastName: result.full.lastName,
      title: result.full.title,
      email: result.full.email,
      directPhone: result.full.directPhone,
      linkedinUrl: result.full.linkedinUrl,
    },
  };
}

/**
 * Free people search scoped to an entity. Persists pre-enrichment
 * rows in entity_contact_enrichments so they appear in the
 * Decision-makers panel even before enrichment.
 */
export async function searchApolloPeopleForEntityAction(input: {
  entitySlug: string;
  personTitles?: string[];
  personSeniorities?: ApolloSeniority[];
  qKeywords?: string;
}): Promise<ApolloActionResult> {
  const { company } = await requireCompany();
  const ref = await resolveApolloEntityRef(input.entitySlug);
  if (!ref) {
    return { ok: false, reason: 'entity-not-found', message: 'Entity not found.' };
  }
  if (!ref.apolloOrgId && !ref.primaryDomain) {
    return {
      ok: false,
      reason: 'no-apollo-scope',
      message:
        'Match this entity to Apollo first (set primary domain, then click Refresh).',
    };
  }

  const filters: ApolloPeopleSearchFilters = {
    organizationIds: ref.apolloOrgId ? [ref.apolloOrgId] : undefined,
    organizationDomainsList:
      !ref.apolloOrgId && ref.primaryDomain ? [ref.primaryDomain] : undefined,
    personTitles: input.personTitles?.length ? input.personTitles : undefined,
    personSeniorities: input.personSeniorities?.length
      ? input.personSeniorities
      : undefined,
    qKeywords: input.qKeywords || undefined,
  };

  const result = await searchPeople({
    filters,
    entitySlug: input.entitySlug,
    companyId: company.id,
    opts: { perPage: 25 },
  });
  if ('ok' in result && result.ok === false) {
    return { ok: false, reason: result.reason, message: degradeMessage(result.reason) };
  }
  if ('people' in result) {
    revalidatePath(`/entities/${input.entitySlug}`);
    return {
      ok: true,
      message:
        result.people.length === 0
          ? 'No matching people found.'
          : `Found ${result.people.length} matching ${
              result.people.length === 1 ? 'person' : 'people'
            }.`,
    };
  }
  return { ok: false, reason: 'unknown', message: 'Unexpected response from Apollo.' };
}
