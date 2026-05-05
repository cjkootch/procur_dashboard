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

/** Endpoint identifiers used in the credit log. */
export const APOLLO_ENDPOINT_GET_ORG = 'organizations.get' as const;
export const APOLLO_ENDPOINT_SEARCH = 'mixed_companies.search' as const;
export type ApolloEndpoint =
  | typeof APOLLO_ENDPOINT_GET_ORG
  | typeof APOLLO_ENDPOINT_SEARCH;

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
