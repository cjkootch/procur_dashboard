import { and, eq } from 'drizzle-orm';
import {
  db,
  entityContactEnrichments,
  type EntityContactEnrichmentRow,
  type NewEntityContactEnrichmentRow,
} from '@procur/db';
import {
  APOLLO_DAILY_PEOPLE_ENRICHMENT_CAP,
  APOLLO_ENDPOINT_PEOPLE_BULK_MATCH,
  APOLLO_ENDPOINT_PEOPLE_MATCH,
  APOLLO_ENDPOINT_PEOPLE_SEARCH,
} from './config';
import {
  countPeopleEnrichmentsLastDay,
  describeApolloCallArgs,
} from './credit-log';
import { apolloFetch } from './transport';
import type {
  ApolloDegradeResult,
  ApolloEmailStatus,
  ApolloPeopleSearchFilters,
  ApolloPeopleSearchResult,
  ApolloPersonEnrichmentResult,
  ApolloPersonFull,
  ApolloPersonThin,
  ApolloSeniority,
} from './types';

// ─── searchPeople — free discovery ─────────────────────────────────

export type SearchPeopleArgs = {
  filters: ApolloPeopleSearchFilters;
  /** When supplied, persists matched people as pre-enrichment rows
   *  in entity_contact_enrichments so the Decision-makers panel
   *  reflects the search before enrichment. */
  entitySlug?: string;
  /** Tenant scope — required when entitySlug is supplied so the
   *  credit log can attribute the call to the right tenant. */
  companyId?: string;
  opts?: { page?: number; perPage?: number };
};

export async function searchPeople(
  args: SearchPeopleArgs,
): Promise<ApolloPeopleSearchResult | ApolloDegradeResult> {
  const page = args.opts?.page ?? 1;
  const perPage = Math.min(args.opts?.perPage ?? 25, 100);

  const body = buildPeopleSearchBody(args.filters, page, perPage);

  const result = await apolloFetch<RawApolloPeopleSearchResponse>({
    endpoint: APOLLO_ENDPOINT_PEOPLE_SEARCH,
    path: '/mixed_people/api_search',
    method: 'POST',
    body,
    argsHash: describeApolloCallArgs({ ...body, page, per_page: perPage }),
    companyId: args.companyId,
    page,
    perPage,
  });

  if (!result.ok) return result;

  const people = (result.data.people ?? []).map(mapApolloPersonThin);

  // Persist pre-enrichment rows when an entity is in scope. These
  // are sidecar suggestions (source = 'apollo') that the
  // Decision-makers panel renders alongside enriched rows.
  if (args.entitySlug) {
    for (const person of people) {
      await upsertPreEnrichmentRow(args.entitySlug, person);
    }
  }

  return {
    people,
    totalEntries: result.data.total_entries ?? 0,
    page,
    perPage,
  };
}

// ─── enrichPerson — paid, per-tenant per-day cap ───────────────────

export type EnrichPersonArgs = {
  apolloPersonId: string;
  entitySlug: string;
  companyId: string;
  /** Override the default per-tenant per-day cap (default 25 per
   *  apollo brief §11). Set to a higher value in admin per tenant. */
  dailyCap?: number;
};

export async function enrichPerson(
  args: EnrichPersonArgs,
): Promise<ApolloPersonEnrichmentResult | ApolloDegradeResult> {
  const cap = args.dailyCap ?? APOLLO_DAILY_PEOPLE_ENRICHMENT_CAP;
  const todaysCount = await countPeopleEnrichmentsLastDay({
    companyId: args.companyId,
  });
  if (todaysCount >= cap) {
    return {
      ok: false,
      reason: 'tenant-daily-enrichment-cap-reached',
      message: `Tenant has used ${todaysCount}/${cap} enrichment calls in the last 24 hours.`,
    };
  }

  const result = await apolloFetch<{ person: RawApolloPersonFull }>({
    endpoint: APOLLO_ENDPOINT_PEOPLE_MATCH,
    path: '/people/match',
    method: 'POST',
    body: { id: args.apolloPersonId },
    argsHash: describeApolloCallArgs({ id: args.apolloPersonId }),
    companyId: args.companyId,
  });

  if (!result.ok) return result;

  const full = mapApolloPersonFull(result.data.person);
  const enrichedAt = new Date();
  await persistEnrichedRow(args.entitySlug, full, enrichedAt);

  return {
    ok: true,
    apolloPersonId: full.id,
    full,
    enrichedAt,
  };
}

// ─── enrichPeopleBulk — paid, confirmedCount + cap ─────────────────

export type EnrichPeopleBulkArgs = {
  apolloPersonIds: string[];
  entitySlug: string;
  companyId: string;
  /** Defensive check that the caller has shown the operator the
   *  count + cost before calling. Must equal apolloPersonIds.length. */
  confirmedCount: number;
  dailyCap?: number;
};

export type EnrichPeopleBulkResult = {
  enriched: number;
  failed: { apolloPersonId: string; reason: string }[];
  apiCalls: number;
};

export async function enrichPeopleBulk(
  args: EnrichPeopleBulkArgs,
): Promise<EnrichPeopleBulkResult | ApolloDegradeResult> {
  if (args.confirmedCount !== args.apolloPersonIds.length) {
    return {
      ok: false,
      reason: 'unconfirmed-bulk-enrichment',
      message: `confirmedCount=${args.confirmedCount} does not match ids.length=${args.apolloPersonIds.length}. Caller must show operator the count + cost.`,
    };
  }

  const cap = args.dailyCap ?? APOLLO_DAILY_PEOPLE_ENRICHMENT_CAP;
  const todaysCount = await countPeopleEnrichmentsLastDay({
    companyId: args.companyId,
  });
  if (todaysCount >= cap) {
    return {
      ok: false,
      reason: 'tenant-daily-enrichment-cap-reached',
      message: `Tenant has used ${todaysCount}/${cap} enrichment calls in the last 24 hours.`,
    };
  }

  const result = await apolloFetch<{
    matches?: Array<RawApolloPersonFull | null>;
  }>({
    endpoint: APOLLO_ENDPOINT_PEOPLE_BULK_MATCH,
    path: '/people/bulk_match',
    method: 'POST',
    body: { details: args.apolloPersonIds.map((id) => ({ id })) },
    argsHash: describeApolloCallArgs({
      ids_count: args.apolloPersonIds.length,
    }),
    companyId: args.companyId,
  });

  if (!result.ok) return result;

  const enrichedAt = new Date();
  const matches = result.data.matches ?? [];
  let enriched = 0;
  const failed: { apolloPersonId: string; reason: string }[] = [];

  for (let i = 0; i < args.apolloPersonIds.length; i += 1) {
    const id = args.apolloPersonIds[i]!;
    const raw = matches[i];
    if (!raw) {
      failed.push({ apolloPersonId: id, reason: 'apollo-no-match' });
      continue;
    }
    const full = mapApolloPersonFull(raw);
    await persistEnrichedRow(args.entitySlug, full, enrichedAt);
    enriched += 1;
  }

  return { enriched, failed, apiCalls: 1 };
}

// ─── Internal helpers ──────────────────────────────────────────────

type RawApolloPersonThin = {
  id: string;
  first_name?: string | null;
  last_name_obfuscated?: string | null;
  title?: string | null;
  last_refreshed_at?: string | null;
  has_email?: boolean | null;
  has_city?: boolean | null;
  has_state?: boolean | null;
  has_country?: boolean | null;
  has_direct_phone?: string | null;
  organization?: {
    name?: string | null;
    has_industry?: boolean | null;
    has_phone?: boolean | null;
    has_city?: boolean | null;
    has_state?: boolean | null;
    has_country?: boolean | null;
    has_zip_code?: boolean | null;
    has_revenue?: boolean | null;
    has_employee_count?: boolean | null;
  } | null;
};

type RawApolloPersonFull = {
  id: string;
  first_name?: string | null;
  last_name?: string | null;
  title?: string | null;
  email?: string | null;
  email_status?: string | null;
  phone?: string | null;
  /** Apollo returns several phone fields; we surface the first
   *  available direct dial. */
  phone_numbers?: Array<{
    raw_number?: string | null;
    sanitized_number?: string | null;
    type?: string | null;
    position?: number | null;
    status?: string | null;
  }> | null;
  linkedin_url?: string | null;
  seniority?: string | null;
  city?: string | null;
  state?: string | null;
  country?: string | null;
  organization_id?: string | null;
  organization?: { id?: string | null; name?: string | null } | null;
  last_refreshed_at?: string | null;
};

type RawApolloPeopleSearchResponse = {
  total_entries?: number;
  people?: RawApolloPersonThin[];
};

function mapApolloPersonThin(raw: RawApolloPersonThin): ApolloPersonThin {
  return {
    id: raw.id,
    firstName: raw.first_name ?? '',
    lastNameObfuscated: raw.last_name_obfuscated ?? '',
    title: raw.title ?? null,
    lastRefreshedAt: raw.last_refreshed_at ?? null,
    hasEmail: raw.has_email === true,
    hasCity: raw.has_city === true,
    hasState: raw.has_state === true,
    hasCountry: raw.has_country === true,
    hasDirectPhone: raw.has_direct_phone ?? null,
    organization: raw.organization
      ? {
          name: raw.organization.name ?? null,
          hasIndustry: raw.organization.has_industry === true,
          hasPhone: raw.organization.has_phone === true,
          hasCity: raw.organization.has_city === true,
          hasState: raw.organization.has_state === true,
          hasCountry: raw.organization.has_country === true,
          hasZipCode: raw.organization.has_zip_code === true,
          hasRevenue: raw.organization.has_revenue === true,
          hasEmployeeCount: raw.organization.has_employee_count === true,
        }
      : null,
  };
}

function mapApolloPersonFull(raw: RawApolloPersonFull): ApolloPersonFull {
  return {
    id: raw.id,
    firstName: raw.first_name ?? '',
    lastName: raw.last_name ?? '',
    title: raw.title ?? null,
    email: raw.email ?? null,
    emailStatus: isEmailStatus(raw.email_status) ? raw.email_status : null,
    directPhone: raw.phone ?? raw.phone_numbers?.[0]?.sanitized_number ?? null,
    linkedinUrl: raw.linkedin_url ?? null,
    seniority: isSeniority(raw.seniority) ? raw.seniority : null,
    city: raw.city ?? null,
    state: raw.state ?? null,
    country: raw.country ?? null,
    organizationId: raw.organization_id ?? raw.organization?.id ?? null,
    organizationName: raw.organization?.name ?? null,
    lastRefreshedAt: raw.last_refreshed_at ?? null,
  };
}

function isEmailStatus(v: unknown): v is ApolloEmailStatus {
  return (
    v === 'verified' || v === 'unverified' || v === 'likely to engage' || v === 'unavailable'
  );
}

function isSeniority(v: unknown): v is ApolloSeniority {
  if (typeof v !== 'string') return false;
  return [
    'owner',
    'founder',
    'c_suite',
    'partner',
    'vp',
    'head',
    'director',
    'manager',
    'senior',
    'entry',
    'intern',
  ].includes(v);
}

function emailStatusConfidence(status: ApolloEmailStatus | null): string | null {
  switch (status) {
    case 'verified':
      return '0.95';
    case 'likely to engage':
      return '0.75';
    case 'unverified':
      return '0.50';
    case 'unavailable':
      return '0.10';
    default:
      return null;
  }
}

function normalizeContactName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildPeopleSearchBody(
  filters: ApolloPeopleSearchFilters,
  page: number,
  perPage: number,
): Record<string, unknown> {
  const body: Record<string, unknown> = { page, per_page: perPage };

  if (filters.organizationIds?.length) body.organization_ids = filters.organizationIds;
  if (filters.organizationDomainsList?.length) {
    body.q_organization_domains_list = filters.organizationDomainsList;
  }
  if (filters.personTitles?.length) body.person_titles = filters.personTitles;
  if (filters.includeSimilarTitles != null) {
    body.include_similar_titles = filters.includeSimilarTitles;
  }
  if (filters.qKeywords) body.q_keywords = filters.qKeywords;
  if (filters.personLocations?.length) body.person_locations = filters.personLocations;
  if (filters.personSeniorities?.length) {
    body.person_seniorities = filters.personSeniorities;
  }
  if (filters.organizationLocations?.length) {
    body.organization_locations = filters.organizationLocations;
  }
  if (filters.organizationNumEmployeesRanges?.length) {
    body.organization_num_employees_ranges = filters.organizationNumEmployeesRanges;
  }
  if (filters.contactEmailStatus?.length) {
    body.contact_email_status = filters.contactEmailStatus;
  }
  if (filters.revenueRangeMin != null) body['revenue_range[min]'] = filters.revenueRangeMin;
  if (filters.revenueRangeMax != null) body['revenue_range[max]'] = filters.revenueRangeMax;
  if (filters.currentlyUsingAnyOfTechnologyUids?.length) {
    body.currently_using_any_of_technology_uids = filters.currentlyUsingAnyOfTechnologyUids;
  }
  if (filters.organizationJobTitles?.length) {
    body.q_organization_job_titles = filters.organizationJobTitles;
  }
  if (filters.organizationJobLocations?.length) {
    body.organization_job_locations = filters.organizationJobLocations;
  }
  if (filters.organizationJobPostedAtMin) {
    body['organization_job_posted_at_range[min]'] = filters.organizationJobPostedAtMin;
  }
  if (filters.organizationJobPostedAtMax) {
    body['organization_job_posted_at_range[max]'] = filters.organizationJobPostedAtMax;
  }

  return body;
}

async function findApolloRow(
  entitySlug: string,
  apolloPersonId: string,
): Promise<EntityContactEnrichmentRow | null> {
  const rows = await db
    .select()
    .from(entityContactEnrichments)
    .where(
      and(
        eq(entityContactEnrichments.entitySlug, entitySlug),
        eq(entityContactEnrichments.apolloPersonId, apolloPersonId),
        eq(entityContactEnrichments.source, 'apollo'),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

async function upsertPreEnrichmentRow(
  entitySlug: string,
  person: ApolloPersonThin,
): Promise<void> {
  const existing = await findApolloRow(entitySlug, person.id);
  if (existing) {
    // Refresh title + last_refreshed_at; keep email/phone if already
    // enriched.
    await db
      .update(entityContactEnrichments)
      .set({
        title: person.title ?? existing.title,
        apolloLastRefreshedAt: person.lastRefreshedAt
          ? new Date(person.lastRefreshedAt)
          : existing.apolloLastRefreshedAt,
        updatedAt: new Date(),
      })
      .where(eq(entityContactEnrichments.id, existing.id));
    return;
  }

  const obfuscatedFullName = `${person.firstName} ${person.lastNameObfuscated}`.trim();
  const enrichedAt = new Date();
  const row: NewEntityContactEnrichmentRow = {
    entitySlug,
    contactName: obfuscatedFullName,
    contactNameNormalized: normalizeContactName(obfuscatedFullName),
    title: person.title ?? null,
    source: 'apollo',
    apolloPersonId: person.id,
    apolloLastRefreshedAt: person.lastRefreshedAt
      ? new Date(person.lastRefreshedAt)
      : null,
    enrichedAt,
  };
  await db.insert(entityContactEnrichments).values(row).onConflictDoNothing();
}

async function persistEnrichedRow(
  entitySlug: string,
  full: ApolloPersonFull,
  enrichedAt: Date,
): Promise<void> {
  const existing = await findApolloRow(entitySlug, full.id);
  const fullName = `${full.firstName} ${full.lastName}`.trim();

  const update = {
    contactName: fullName,
    contactNameNormalized: normalizeContactName(fullName),
    email: full.email ?? null,
    emailConfidence: emailStatusConfidence(full.emailStatus),
    title: full.title ?? null,
    phone: full.directPhone ?? null,
    linkedinUrl: full.linkedinUrl ?? null,
    seniority: full.seniority ?? null,
    apolloLastRefreshedAt: full.lastRefreshedAt
      ? new Date(full.lastRefreshedAt)
      : null,
    enrichedAt,
    updatedAt: new Date(),
  };

  if (existing) {
    await db
      .update(entityContactEnrichments)
      .set(update)
      .where(eq(entityContactEnrichments.id, existing.id));
    return;
  }

  // No prior row — create one. This happens when the operator
  // enriches a person without going through searchPeople first
  // (e.g. via a direct apolloPersonId from another flow).
  const row: NewEntityContactEnrichmentRow = {
    entitySlug,
    ...update,
    source: 'apollo',
    apolloPersonId: full.id,
  };
  await db.insert(entityContactEnrichments).values(row).onConflictDoNothing();
}
