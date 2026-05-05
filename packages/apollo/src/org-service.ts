import { eq } from 'drizzle-orm';
import {
  db,
  knownEntities,
  externalSuppliers,
} from '@procur/db';
import {
  APOLLO_ENDPOINT_GET_ORG,
  APOLLO_ENDPOINT_SEARCH,
  APOLLO_BATCH_DOMAINS_PER_CALL,
  APOLLO_SINGLE_GET_FRESHNESS_DAYS,
} from './config';
import { describeApolloCallArgs } from './credit-log';
import { apolloFetch } from './transport';
import type {
  ApolloOrgFull,
  ApolloOrgThin,
  ApolloOrgSnapshot,
  ApolloSearchFilters,
  ApolloSearchResult,
  ApolloDegradeResult,
} from './types';

// ─── Single-org enrichment via GET /organizations/{id} ──────────────

export type EnrichOrgTarget = {
  table: 'known_entities' | 'external_suppliers';
  /** The entity row id (uuid) — known_entities.id or
   *  external_suppliers.id. */
  id: string;
};

export type EnrichOrgFromApolloArgs = {
  apolloOrgId: string;
  target: EnrichOrgTarget;
  /** Skip the API call if cache is fresher than this. Default 30 days. */
  freshnessHours?: number;
};

export type EnrichOrgFromApolloResult =
  | { ok: true; cacheHit: boolean; snapshot: ApolloOrgSnapshot }
  | ApolloDegradeResult;

/**
 * Single-org full enrichment. Writes the snapshot to the target row
 * and returns it. Skips the API call when the cached snapshot is
 * fresher than `freshnessHours` (default 30 days per brief §5).
 */
export async function enrichOrgFromApollo(
  args: EnrichOrgFromApolloArgs,
): Promise<EnrichOrgFromApolloResult> {
  const freshnessMs =
    (args.freshnessHours ?? APOLLO_SINGLE_GET_FRESHNESS_DAYS * 24) * 60 * 60 * 1000;

  // Cache freshness check.
  const cached = await readCachedSnapshot(args.target);
  if (cached && Date.now() - cached.syncedAt.getTime() < freshnessMs) {
    return { ok: true, cacheHit: true, snapshot: cached };
  }

  const result = await apolloFetch<{ organization: RawApolloOrgFull }>({
    endpoint: APOLLO_ENDPOINT_GET_ORG,
    path: `/organizations/${encodeURIComponent(args.apolloOrgId)}`,
    method: 'GET',
    argsHash: describeApolloCallArgs({ id: args.apolloOrgId }),
  });

  if (!result.ok) return result;

  const full = mapApolloOrgFull(result.data.organization);
  const syncedAt = new Date();
  const snapshot: ApolloOrgSnapshot = {
    apolloOrgId: full.id,
    syncedAt,
    fundingStage: full.latestFundingStage,
    totalFunding: full.totalFunding,
    latestFundingAt: full.latestFundingRoundDate,
    estimatedEmployees: full.estimatedNumEmployees,
    annualRevenue: full.annualRevenue,
    full,
  };

  await writeOrgSnapshot(args.target, snapshot);

  return { ok: true, cacheHit: false, snapshot };
}

// ─── Batch enrichment via POST /mixed_companies/search ──────────────

export type EnrichOrgsBatchArgs = {
  /** Up to 1,000 domains per call; chunked internally if larger. */
  domains: string[];
  targetTable: 'known_entities' | 'external_suppliers';
};

export type EnrichOrgsBatchResult = {
  matched: number;
  unmatched: string[];
  apiCalls: number;
};

/**
 * Batch enrichment via the search endpoint's q_organization_domains_list
 * filter. Apollo accepts up to 1,000 domains per call. The function
 * chunks larger inputs and writes back the thin snapshot + apollo_org_id
 * to whichever entity table matches by primary_domain.
 */
export async function enrichOrgsBatch(
  args: EnrichOrgsBatchArgs,
): Promise<EnrichOrgsBatchResult | ApolloDegradeResult> {
  const seenDomains = new Set(args.domains.map((d) => d.toLowerCase()));
  const matched = new Set<string>();
  let apiCalls = 0;

  for (const chunk of chunkBy(args.domains, APOLLO_BATCH_DOMAINS_PER_CALL)) {
    const result = await apolloFetch<RawApolloSearchResponse>({
      endpoint: APOLLO_ENDPOINT_SEARCH,
      path: '/mixed_companies/search',
      method: 'POST',
      body: { q_organization_domains_list: chunk, per_page: 100 },
      argsHash: describeApolloCallArgs({
        domains_count: chunk.length,
      }),
    });

    if (!result.ok) {
      return result;
    }

    apiCalls += 1;

    for (const raw of result.data.organizations ?? []) {
      const orgThin = mapApolloOrgThin(raw);
      const domain = orgThin.primaryDomain?.toLowerCase();
      if (!domain || !seenDomains.has(domain)) continue;

      await writeOrgThinByDomain(args.targetTable, domain, orgThin);
      matched.add(domain);
    }
  }

  const unmatched = [...seenDomains].filter((d) => !matched.has(d));
  return {
    matched: matched.size,
    unmatched,
    apiCalls,
  };
}

// ─── Discovery via POST /mixed_companies/search ─────────────────────

export type SearchOrgsOpts = {
  page?: number;
  perPage?: number;
};

export async function searchOrgs(
  filters: ApolloSearchFilters,
  opts: SearchOrgsOpts = {},
): Promise<ApolloSearchResult | ApolloDegradeResult> {
  const page = opts.page ?? 1;
  const perPage = Math.min(opts.perPage ?? 25, 100);

  const body = buildOrgSearchBody(filters, page, perPage);

  const result = await apolloFetch<RawApolloSearchResponse>({
    endpoint: APOLLO_ENDPOINT_SEARCH,
    path: '/mixed_companies/search',
    method: 'POST',
    body,
    argsHash: describeApolloCallArgs({ ...body, page, per_page: perPage }),
    page,
    perPage,
  });

  if (!result.ok) return result;

  return {
    organizations: (result.data.organizations ?? []).map(mapApolloOrgThin),
    pagination: {
      page: result.data.pagination?.page ?? page,
      perPage: result.data.pagination?.per_page ?? perPage,
      totalEntries: result.data.pagination?.total_entries ?? 0,
      totalPages: result.data.pagination?.total_pages ?? 0,
    },
    partialResultsOnly: result.data.partial_results_only ?? false,
  };
}

// ─── Internal helpers ──────────────────────────────────────────────

type RawApolloOrgFull = {
  id: string;
  name?: string | null;
  primary_domain?: string | null;
  website_url?: string | null;
  linkedin_url?: string | null;
  founded_year?: number | null;
  industry?: string | null;
  industries?: string[] | null;
  keywords?: string[] | null;
  estimated_num_employees?: number | null;
  annual_revenue?: number | null;
  annual_revenue_printed?: string | null;
  total_funding?: number | null;
  total_funding_printed?: string | null;
  latest_funding_round_date?: string | null;
  latest_funding_stage?: string | null;
  funding_events?: Array<{
    id: string;
    date?: string | null;
    news_url?: string | null;
    type?: string | null;
    investors?: string | null;
    amount?: string | null;
    currency?: string | null;
  }> | null;
  technology_names?: string[] | null;
  current_technologies?: Array<{ uid: string; name: string; category: string }> | null;
  employee_metrics?: Array<{
    start_date: string;
    departments: Array<{
      functions: string | null;
      new: number;
      retained: number;
      churned: number;
    }>;
  }> | null;
  raw_address?: string | null;
  street_address?: string | null;
  city?: string | null;
  state?: string | null;
  postal_code?: string | null;
  country?: string | null;
  short_description?: string | null;
};

type RawApolloOrgThin = {
  id: string;
  name?: string | null;
  primary_domain?: string | null;
  website_url?: string | null;
  linkedin_url?: string | null;
  founded_year?: number | null;
};

type RawApolloSearchResponse = {
  organizations?: RawApolloOrgThin[];
  pagination?: {
    page?: number;
    per_page?: number;
    total_entries?: number;
    total_pages?: number;
  };
  partial_results_only?: boolean;
};

function mapApolloOrgFull(raw: RawApolloOrgFull): ApolloOrgFull {
  return {
    id: raw.id,
    name: raw.name ?? '',
    primaryDomain: raw.primary_domain ?? null,
    websiteUrl: raw.website_url ?? null,
    linkedinUrl: raw.linkedin_url ?? null,
    foundedYear: raw.founded_year ?? null,
    industry: raw.industry ?? null,
    industries: raw.industries ?? [],
    keywords: raw.keywords ?? [],
    estimatedNumEmployees: raw.estimated_num_employees ?? null,
    annualRevenue: raw.annual_revenue ?? null,
    annualRevenuePrinted: raw.annual_revenue_printed ?? null,
    totalFunding: raw.total_funding ?? null,
    totalFundingPrinted: raw.total_funding_printed ?? null,
    latestFundingRoundDate: raw.latest_funding_round_date ?? null,
    latestFundingStage: raw.latest_funding_stage ?? null,
    fundingEvents: (raw.funding_events ?? []).map((f) => ({
      id: f.id,
      date: f.date ?? '',
      newsUrl: f.news_url ?? null,
      type: f.type ?? null,
      investors: f.investors ?? null,
      amount: f.amount ?? null,
      currency: f.currency ?? null,
    })),
    technologyNames: raw.technology_names ?? [],
    currentTechnologies: raw.current_technologies ?? [],
    employeeMetrics: (raw.employee_metrics ?? []).map((m) => ({
      startDate: m.start_date,
      departments: m.departments,
    })),
    rawAddress: raw.raw_address ?? null,
    streetAddress: raw.street_address ?? null,
    city: raw.city ?? null,
    state: raw.state ?? null,
    postalCode: raw.postal_code ?? null,
    country: raw.country ?? null,
    shortDescription: raw.short_description ?? null,
  };
}

function mapApolloOrgThin(raw: RawApolloOrgThin): ApolloOrgThin {
  return {
    id: raw.id,
    name: raw.name ?? '',
    primaryDomain: raw.primary_domain ?? null,
    websiteUrl: raw.website_url ?? null,
    linkedinUrl: raw.linkedin_url ?? null,
    foundedYear: raw.founded_year ?? null,
  };
}

/** Build the Apollo bracket-notation request body from camelCase filters. */
function buildOrgSearchBody(
  filters: ApolloSearchFilters,
  page: number,
  perPage: number,
): Record<string, unknown> {
  const body: Record<string, unknown> = { page, per_page: perPage };

  if (filters.organizationDomainsList?.length) {
    body.q_organization_domains_list = filters.organizationDomainsList;
  }
  if (filters.organizationIds?.length) body.organization_ids = filters.organizationIds;
  if (filters.organizationName) body.q_organization_name = filters.organizationName;
  if (filters.organizationKeywordTags?.length) {
    body.q_organization_keyword_tags = filters.organizationKeywordTags;
  }
  if (filters.organizationLocations?.length) {
    body.organization_locations = filters.organizationLocations;
  }
  if (filters.organizationNotLocations?.length) {
    body.organization_not_locations = filters.organizationNotLocations;
  }
  if (filters.organizationNumEmployeesRanges?.length) {
    body.organization_num_employees_ranges = filters.organizationNumEmployeesRanges;
  }
  if (filters.revenueRangeMin != null) body['revenue_range[min]'] = filters.revenueRangeMin;
  if (filters.revenueRangeMax != null) body['revenue_range[max]'] = filters.revenueRangeMax;
  if (filters.currentlyUsingAnyOfTechnologyUids?.length) {
    body.currently_using_any_of_technology_uids = filters.currentlyUsingAnyOfTechnologyUids;
  }
  if (filters.latestFundingAmountMin != null) {
    body['latest_funding_amount_range[min]'] = filters.latestFundingAmountMin;
  }
  if (filters.latestFundingAmountMax != null) {
    body['latest_funding_amount_range[max]'] = filters.latestFundingAmountMax;
  }
  if (filters.totalFundingMin != null) {
    body['total_funding_range[min]'] = filters.totalFundingMin;
  }
  if (filters.totalFundingMax != null) {
    body['total_funding_range[max]'] = filters.totalFundingMax;
  }
  if (filters.latestFundingDateMin) {
    body['latest_funding_date_range[min]'] = filters.latestFundingDateMin;
  }
  if (filters.latestFundingDateMax) {
    body['latest_funding_date_range[max]'] = filters.latestFundingDateMax;
  }
  if (filters.organizationJobTitles?.length) {
    body.q_organization_job_titles = filters.organizationJobTitles;
  }
  if (filters.organizationJobLocations?.length) {
    body.organization_job_locations = filters.organizationJobLocations;
  }
  if (filters.organizationNumJobsMin != null) {
    body['organization_num_jobs_range[min]'] = filters.organizationNumJobsMin;
  }
  if (filters.organizationNumJobsMax != null) {
    body['organization_num_jobs_range[max]'] = filters.organizationNumJobsMax;
  }
  if (filters.organizationJobPostedAtMin) {
    body['organization_job_posted_at_range[min]'] = filters.organizationJobPostedAtMin;
  }
  if (filters.organizationJobPostedAtMax) {
    body['organization_job_posted_at_range[max]'] = filters.organizationJobPostedAtMax;
  }

  return body;
}

function chunkBy<T>(arr: T[], size: number): T[][] {
  if (size <= 0) return [arr];
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

async function readCachedSnapshot(
  target: EnrichOrgTarget,
): Promise<ApolloOrgSnapshot | null> {
  const table = target.table === 'known_entities' ? knownEntities : externalSuppliers;
  const rows = await db
    .select()
    .from(table)
    .where(eq(table.id, target.id))
    .limit(1);
  const row = rows[0];
  if (!row || !row.apolloOrgId || !row.apolloSnapshot || !row.apolloSyncedAt) {
    return null;
  }
  const full = row.apolloSnapshot as unknown as ApolloOrgFull;
  return {
    apolloOrgId: row.apolloOrgId,
    syncedAt: row.apolloSyncedAt,
    fundingStage: row.apolloFundingStage,
    totalFunding: row.apolloTotalFunding,
    latestFundingAt: row.apolloLatestFundingAt,
    estimatedEmployees: row.apolloEstimatedEmployees,
    annualRevenue: row.apolloAnnualRevenue,
    full,
  };
}

async function writeOrgSnapshot(
  target: EnrichOrgTarget,
  snapshot: ApolloOrgSnapshot,
): Promise<void> {
  const update = {
    apolloOrgId: snapshot.apolloOrgId,
    apolloSyncedAt: snapshot.syncedAt,
    apolloFundingStage: snapshot.fundingStage,
    apolloTotalFunding: snapshot.totalFunding,
    apolloLatestFundingAt: snapshot.latestFundingAt,
    apolloEstimatedEmployees: snapshot.estimatedEmployees,
    apolloAnnualRevenue: snapshot.annualRevenue,
    apolloSnapshot: snapshot.full,
  };
  if (target.table === 'known_entities') {
    await db.update(knownEntities).set(update).where(eq(knownEntities.id, target.id));
  } else {
    await db
      .update(externalSuppliers)
      .set(update)
      .where(eq(externalSuppliers.id, target.id));
  }
}

async function writeOrgThinByDomain(
  table: 'known_entities' | 'external_suppliers',
  domain: string,
  orgThin: ApolloOrgThin,
): Promise<void> {
  const now = new Date();
  // Thin updates don't include the wide jsonb snapshot or
  // funding/headcount/revenue — those land on the next single-get.
  const update = {
    apolloOrgId: orgThin.id,
    apolloSyncedAt: now,
  };
  if (table === 'known_entities') {
    await db
      .update(knownEntities)
      .set(update)
      .where(eq(knownEntities.primaryDomain, domain));
  } else {
    await db
      .update(externalSuppliers)
      .set(update)
      .where(eq(externalSuppliers.primaryDomain, domain));
  }
}
