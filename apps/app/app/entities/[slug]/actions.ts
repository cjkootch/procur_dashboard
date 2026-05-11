'use server';

import { revalidatePath } from 'next/cache';
import { requireCompany } from '@procur/auth';
import {
  SupplierApprovalEntityMissingError,
  addManualContactEnrichment,
  resolveApolloEntityRef,
  upsertFormEndpoint,
  upsertSupplierApproval,
} from '@procur/catalog';
import { crawlSingleEntity } from '@procur/ai';
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

/**
 * Manual operator-add path for a contact-form endpoint. The crawler
 * surfaces most forms automatically, but operators can paste in a
 * URL + field-name resolutions when:
 *   - The crawler missed a deeper / non-linked-from-homepage form
 *   - The crawler misclassified a field role (e.g., wrong
 *     message_field — a free-text "company" field got picked up
 *     instead of the actual textarea)
 *   - The form lives behind a JS-rendered page where the crawler
 *     can't see the markup
 *
 * Operator submission ALWAYS sets source='operator' which wins over
 * subsequent crawler updates per the upsert policy. CAPTCHA detection
 * still runs against operator-supplied URLs on the next crawl pass —
 * the operator can override the captcha decision with the dedicated
 * action below if they're certain (e.g., an invisible reCAPTCHA that
 * the form auto-passes for trusted referrers; rare but exists).
 */
export async function addLeadFormEndpointAction(
  formData: FormData,
): Promise<{ ok: boolean; message: string }> {
  await requireCompany();
  const entitySlug = String(formData.get('entitySlug') ?? '').trim();
  const url = String(formData.get('url') ?? '').trim();
  if (!entitySlug || !url) {
    return { ok: false, message: 'entitySlug + url required' };
  }
  try {
    new URL(url);
  } catch {
    return { ok: false, message: 'url must be a valid absolute URL' };
  }
  const messageField =
    String(formData.get('messageField') ?? '').trim() || null;
  const emailField =
    String(formData.get('emailField') ?? '').trim() || null;
  const nameField =
    String(formData.get('nameField') ?? '').trim() || null;
  const subjectField =
    String(formData.get('subjectField') ?? '').trim() || null;
  const companyField =
    String(formData.get('companyField') ?? '').trim() || null;
  const phoneField =
    String(formData.get('phoneField') ?? '').trim() || null;

  await upsertFormEndpoint({
    entitySlug,
    url,
    submitMethod: 'http_post',
    detectedCaptchaKind: null,
    fields: [],
    nameField,
    emailField,
    subjectField,
    messageField,
    companyField,
    phoneField,
    source: 'operator',
  });
  revalidatePath(`/entities/${entitySlug}`);
  return {
    ok: true,
    message: messageField
      ? 'Form endpoint saved.'
      : 'Form endpoint saved. Set message_field before this endpoint can be autopilot-eligible.',
  };
}

/**
 * Operator-only action to retire an endpoint from autopilot
 * eligibility — set submit_method='unknown' so pickAutopilotEligibleEndpoint
 * filters it out. Used when an operator notices the form is no longer
 * accepting submissions, has been migrated behind a CAPTCHA, etc.
 * Doesn't delete the row — useful audit trail of what URLs we know
 * about. Re-enable by re-running the manual add.
 */
export async function retireLeadFormEndpointAction(
  formData: FormData,
): Promise<{ ok: boolean; message: string }> {
  await requireCompany();
  const entitySlug = String(formData.get('entitySlug') ?? '').trim();
  const url = String(formData.get('url') ?? '').trim();
  if (!entitySlug || !url) {
    return { ok: false, message: 'entitySlug + url required' };
  }
  await upsertFormEndpoint({
    entitySlug,
    url,
    submitMethod: 'unknown',
    source: 'operator',
  });
  revalidatePath(`/entities/${entitySlug}`);
  return { ok: true, message: 'Endpoint retired from autopilot.' };
}

/**
 * Operator-side manual contact entry. Used when Apollo can't
 * find the person (no Apollo org match, person not in Apollo's
 * index) but the operator has the email / phone / LinkedIn from
 * another source. Lands in entity_contact_enrichments with
 * source='manual', confidence 1.00 on every populated field.
 *
 * Idempotent on (entity_slug, source='manual', name) — re-submitting
 * with the same name updates the existing row's fields rather than
 * duplicating.
 */
export async function addManualContactAction(
  formData: FormData,
): Promise<{ ok: boolean; message: string }> {
  await requireCompany();
  const entitySlug = String(formData.get('entitySlug') ?? '').trim();
  const fullName = String(formData.get('fullName') ?? '').trim();
  if (!entitySlug || !fullName) {
    return { ok: false, message: 'Entity + full name required.' };
  }
  await addManualContactEnrichment({
    entitySlug,
    fullName,
    email: String(formData.get('email') ?? '').trim() || null,
    title: String(formData.get('title') ?? '').trim() || null,
    phone: String(formData.get('phone') ?? '').trim() || null,
    linkedinUrl: String(formData.get('linkedinUrl') ?? '').trim() || null,
  });
  revalidatePath(`/entities/${entitySlug}`);
  return { ok: true, message: `Saved manual contact "${fullName}".` };
}

/**
 * Operator-triggered website re-crawl. Wraps `crawlSingleEntity`
 * from @procur/ai with a route-side maxDuration override. Sync HTTP
 * with Anthropic + multi-page fetch + Vercel Blob writes can run
 * 60-300s; route file sets maxDuration accordingly. Trigger.dev v4
 * migration is the proper home for long-running crawls; this is the
 * pragmatic bridge while operators want a manual refresh affordance.
 *
 * Returns ok:false with the underlying error message when the
 * crawler refuses (no primary_domain, robots.txt block, etc.) so
 * the panel can render it.
 */
export async function triggerEntityCrawlAction(
  formData: FormData,
): Promise<{ ok: boolean; message: string }> {
  await requireCompany();
  const entitySlug = String(formData.get('entitySlug') ?? '').trim();
  if (!entitySlug) {
    return { ok: false, message: 'entitySlug required' };
  }
  const result = await crawlSingleEntity(entitySlug, {
    refresh: true,
    perEntityLimit: 5,
  });
  revalidatePath(`/entities/${entitySlug}`);
  if (!result.ok) {
    return {
      ok: false,
      message: result.error ?? 'Crawl failed for an unknown reason.',
    };
  }
  return { ok: true, message: 'Crawl complete — refresh to see results.' };
}
