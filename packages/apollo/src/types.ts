/**
 * Typed shapes for Apollo.io organization API responses.
 *
 * These cover the fields procur consumes — not the full Apollo
 * response surface. Apollo returns large numbers of fields procur
 * deliberately ignores (intent_signal_account, account, org_chart_*).
 *
 * Spec: docs/apollo-integration-brief.md §3.
 */

/**
 * Subset of the `GET /organizations/{id}` response shape that
 * procur caches and renders. The full Apollo object is preserved
 * separately in `apolloSnapshot` jsonb on the entity row.
 */
export type ApolloOrgFull = {
  id: string;
  name: string;
  primaryDomain: string | null;
  websiteUrl: string | null;
  linkedinUrl: string | null;
  foundedYear: number | null;

  industry: string | null;
  industries: string[];
  keywords: string[];

  estimatedNumEmployees: number | null;
  annualRevenue: number | null;
  annualRevenuePrinted: string | null;

  totalFunding: number | null;
  totalFundingPrinted: string | null;
  latestFundingRoundDate: string | null;
  latestFundingStage: string | null;

  fundingEvents: ApolloFundingEvent[];

  technologyNames: string[];
  currentTechnologies: ApolloTechnology[];

  /** Per-month per-department new/retained/churned counts. */
  employeeMetrics: ApolloEmployeeMetric[];

  rawAddress: string | null;
  streetAddress: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  country: string | null;

  shortDescription: string | null;
};

/** Subset of the search-endpoint org shape — thinner than the
 *  single-get. Notably missing: funding_events, employee_metrics,
 *  current_technologies. Those require a follow-up single-get
 *  per org. */
export type ApolloOrgThin = {
  id: string;
  name: string;
  primaryDomain: string | null;
  websiteUrl: string | null;
  linkedinUrl: string | null;
  foundedYear: number | null;
  /** Search endpoint includes alexa_ranking, primary_phone, and
   *  publicly_traded_* — captured in the snapshot, not surfaced
   *  on cache columns. */
};

export type ApolloFundingEvent = {
  id: string;
  date: string;
  newsUrl: string | null;
  type: string | null;
  investors: string | null;
  amount: string | null;
  currency: string | null;
};

export type ApolloTechnology = {
  uid: string;
  name: string;
  category: string;
};

export type ApolloEmployeeMetric = {
  startDate: string;
  departments: Array<{
    functions: string | null;
    new: number;
    retained: number;
    churned: number;
  }>;
};

// ─── Service-layer return shapes ──────────────────────────────────

/**
 * What enrichOrgFromApollo persists onto the cached entity row.
 * The wide jsonb snapshot is what we wrote, the column-backed
 * fields surface separately in the return shape so callers can
 * use either without re-parsing.
 */
export type ApolloOrgSnapshot = {
  apolloOrgId: string;
  syncedAt: Date;
  fundingStage: string | null;
  totalFunding: number | null;
  latestFundingAt: string | null;
  estimatedEmployees: number | null;
  annualRevenue: number | null;
  /** The full `ApolloOrgFull`, also persisted to the jsonb column. */
  full: ApolloOrgFull;
};

// ─── Search filters ───────────────────────────────────────────────

/**
 * Filter object the service-layer search function takes. Mirrors
 * the Apollo `POST /mixed_companies/search` query parameters.
 *
 * Field names use camelCase here; the Apollo-facing transport layer
 * converts to the bracket-notation form Apollo expects.
 */
export type ApolloSearchFilters = {
  organizationDomainsList?: string[];
  organizationIds?: string[];
  organizationName?: string;
  organizationKeywordTags?: string[];
  organizationLocations?: string[];
  organizationNotLocations?: string[];
  organizationNumEmployeesRanges?: string[];
  revenueRangeMin?: number;
  revenueRangeMax?: number;
  currentlyUsingAnyOfTechnologyUids?: string[];
  latestFundingAmountMin?: number;
  latestFundingAmountMax?: number;
  totalFundingMin?: number;
  totalFundingMax?: number;
  /** ISO yyyy-mm-dd. */
  latestFundingDateMin?: string;
  latestFundingDateMax?: string;
  organizationJobTitles?: string[];
  organizationJobLocations?: string[];
  organizationNumJobsMin?: number;
  organizationNumJobsMax?: number;
  organizationJobPostedAtMin?: string;
  organizationJobPostedAtMax?: string;
};

export type ApolloSearchResult = {
  organizations: ApolloOrgThin[];
  pagination: {
    page: number;
    perPage: number;
    totalEntries: number;
    totalPages: number;
  };
  /** True when Apollo capped the result set at the 50,000-record
   *  display limit. Caller should tighten filters. */
  partialResultsOnly: boolean;
};

// ─── People types (per apollo-integration-brief.md §3.3 / §3.4) ──

/**
 * Apollo's structured seniority enum, used for filtering people
 * search and surfaced on `entity_contact_enrichments.seniority`.
 */
export const APOLLO_SENIORITIES = [
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
] as const;
export type ApolloSeniority = (typeof APOLLO_SENIORITIES)[number];

/** Email-status filter values from the people search endpoint. */
export const APOLLO_EMAIL_STATUSES = [
  'verified',
  'unverified',
  'likely to engage',
  'unavailable',
] as const;
export type ApolloEmailStatus = (typeof APOLLO_EMAIL_STATUSES)[number];

/**
 * People-search response shape. The endpoint is FREE — no credits
 * consumed — and obfuscates last names + omits email/phone. Use the
 * enrichment endpoints to resolve those.
 */
export type ApolloPersonThin = {
  id: string;
  firstName: string;
  /** First 2 chars + asterisks + last 1 char, e.g. "Hu***n". */
  lastNameObfuscated: string;
  title: string | null;
  /** Apollo's data-freshness timestamp for this person. */
  lastRefreshedAt: string | null;
  hasEmail: boolean;
  hasCity: boolean;
  hasState: boolean;
  hasCountry: boolean;
  /** "Yes" | "Maybe: please request direct dial via people/bulk_match". */
  hasDirectPhone: string | null;
  organization: {
    name: string | null;
    hasIndustry: boolean;
    hasPhone: boolean;
    hasCity: boolean;
    hasState: boolean;
    hasCountry: boolean;
    hasZipCode: boolean;
    hasRevenue: boolean;
    hasEmployeeCount: boolean;
  } | null;
};

/**
 * People-enrichment response shape (post /people/match or
 * /people/bulk_match). Resolves email + direct phone + full last
 * name. Paid endpoint.
 */
export type ApolloPersonFull = {
  id: string;
  firstName: string;
  /** Full last name, no obfuscation. */
  lastName: string;
  title: string | null;
  email: string | null;
  emailStatus: ApolloEmailStatus | null;
  /** Direct dial when available. */
  directPhone: string | null;
  linkedinUrl: string | null;
  seniority: ApolloSeniority | null;
  city: string | null;
  state: string | null;
  country: string | null;
  /** Current employer's Apollo org ID, if known. */
  organizationId: string | null;
  organizationName: string | null;
  lastRefreshedAt: string | null;
};

/** Filter object for `searchPeople`. CamelCase here; the transport
 *  layer translates to the bracket-notation form Apollo expects. */
export type ApolloPeopleSearchFilters = {
  /** Apollo org IDs to scope the search to (e.g. "find directors AT this
   *  specific entity"). Preferred over domain when known. */
  organizationIds?: string[];
  /** Employer domain fallback when Apollo org ID isn't known yet. */
  organizationDomainsList?: string[];
  personTitles?: string[];
  /** Default true: returns similar titles too. Set false for strict. */
  includeSimilarTitles?: boolean;
  qKeywords?: string;
  personLocations?: string[];
  personSeniorities?: ApolloSeniority[];
  organizationLocations?: string[];
  organizationNumEmployeesRanges?: string[];
  contactEmailStatus?: ApolloEmailStatus[];
  revenueRangeMin?: number;
  revenueRangeMax?: number;
  currentlyUsingAnyOfTechnologyUids?: string[];
  organizationJobTitles?: string[];
  organizationJobLocations?: string[];
  organizationJobPostedAtMin?: string;
  organizationJobPostedAtMax?: string;
};

export type ApolloPeopleSearchResult = {
  people: ApolloPersonThin[];
  totalEntries: number;
  /** Echoed back from the request. */
  page: number;
  perPage: number;
};

/**
 * Result of a successful single-person enrichment. Persisted by
 * the service-layer enrichPerson into entity_contact_enrichments.
 */
export type ApolloPersonEnrichmentResult = {
  ok: true;
  apolloPersonId: string;
  full: ApolloPersonFull;
  /** When procur wrote the enriched row. */
  enrichedAt: Date;
};

// ─── Error types ──────────────────────────────────────────────────

/**
 * Reasons enrichOrgFromApollo / searchOrgs / enrichPerson /
 * searchPeople return a degrade result instead of throwing. Exposed
 * so callers can tell "no Apollo match" apart from "Apollo disabled"
 * vs "we got rate-limited" vs "tenant hit the daily enrichment cap".
 */
export type ApolloDegradeReason =
  | 'feature-flag-disabled'
  | 'rate-limited-internally'
  | 'no-master-key'
  | 'apollo-no-match'
  | 'apollo-401'
  | 'apollo-403'
  | 'apollo-422'
  | 'apollo-429'
  | 'apollo-transport-error'
  | 'tenant-daily-enrichment-cap-reached'
  | 'unconfirmed-bulk-enrichment';

export type ApolloDegradeResult = {
  ok: false;
  reason: ApolloDegradeReason;
  message: string;
};
