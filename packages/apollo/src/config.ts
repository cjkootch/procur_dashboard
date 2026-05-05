/**
 * Apollo integration configuration. The service-layer functions
 * read these once at module load; callers don't pass credentials.
 *
 * Defaults to disabled outside production. Set APOLLO_ENABLED=true
 * (and provide APOLLO_MASTER_API_KEY) to actually call the API.
 */

export const APOLLO_BASE_URL = 'https://api.apollo.io/api/v1';

/** Hard ceiling we run under, leaving headroom below Apollo's
 *  600/hr per-endpoint cap so concurrent jobs don't trip it. */
export const APOLLO_RATE_LIMIT_PER_HOUR = 500;

/** Maximum domains per /mixed_companies/search call when batch-
 *  enriching. Apollo accepts up to 1,000. */
export const APOLLO_BATCH_DOMAINS_PER_CALL = 1000;

/** Default freshness windows. Both can be overridden per-call. */
export const APOLLO_BATCH_FRESHNESS_DAYS = 7;
export const APOLLO_SINGLE_GET_FRESHNESS_DAYS = 30;

/** Default per-tenant per-day cap on people-enrichment calls
 *  (POST /people/match + /people/bulk_match). Settable upward in
 *  admin per tenant. Per apollo-integration-brief.md §11. */
export const APOLLO_DAILY_PEOPLE_ENRICHMENT_CAP = 25;

/** Endpoint identifiers used in the credit log. */
export const APOLLO_ENDPOINT_GET_ORG = 'organizations.get' as const;
export const APOLLO_ENDPOINT_SEARCH = 'mixed_companies.search' as const;
export const APOLLO_ENDPOINT_PEOPLE_SEARCH = 'mixed_people.api_search' as const;
export const APOLLO_ENDPOINT_PEOPLE_MATCH = 'people.match' as const;
export const APOLLO_ENDPOINT_PEOPLE_BULK_MATCH = 'people.bulk_match' as const;
export type ApolloEndpoint =
  | typeof APOLLO_ENDPOINT_GET_ORG
  | typeof APOLLO_ENDPOINT_SEARCH
  | typeof APOLLO_ENDPOINT_PEOPLE_SEARCH
  | typeof APOLLO_ENDPOINT_PEOPLE_MATCH
  | typeof APOLLO_ENDPOINT_PEOPLE_BULK_MATCH;

/** People-endpoint set — used by the per-tenant cap counter. */
export const APOLLO_PEOPLE_ENRICHMENT_ENDPOINTS: readonly ApolloEndpoint[] = [
  APOLLO_ENDPOINT_PEOPLE_MATCH,
  APOLLO_ENDPOINT_PEOPLE_BULK_MATCH,
];

export type ApolloConfig = {
  enabled: boolean;
  masterApiKey: string | null;
  baseUrl: string;
};

export function loadApolloConfig(): ApolloConfig {
  const enabled = process.env.APOLLO_ENABLED === 'true';
  const masterApiKey = process.env.APOLLO_MASTER_API_KEY ?? null;
  return {
    enabled,
    masterApiKey,
    baseUrl: APOLLO_BASE_URL,
  };
}
