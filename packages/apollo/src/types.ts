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

// ─── Error types ──────────────────────────────────────────────────

/**
 * Reasons enrichOrgFromApollo / searchOrgs return null instead of
 * throwing. Exposed so callers can tell "no Apollo match" apart
 * from "Apollo disabled" or "we got rate-limited".
 */
export type ApolloDegradeReason =
  | 'feature-flag-disabled'
  | 'rate-limited-internally'
  | 'no-master-key'
  | 'apollo-no-match'
  | 'apollo-403'
  | 'apollo-422';

export type ApolloDegradeResult = {
  ok: false;
  reason: ApolloDegradeReason;
  message: string;
};
