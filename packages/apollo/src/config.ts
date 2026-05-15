/**
 * Apollo integration configuration. The service-layer functions
 * read these once at module load; callers don't pass credentials.
 *
 * Defaults to disabled outside production. Set APOLLO_ENABLED=true
 * (and provide APOLLO_MASTER_API_KEY) to actually call the API.
 */

export const APOLLO_BASE_URL = 'https://api.apollo.io/api/v1';

/**
 * Hard ceiling we run under, leaving headroom below Apollo's
 * per-endpoint caps so concurrent jobs don't trip them. Default 500/hr
 * is conservative — appropriate for Free tier or shared chat usage.
 *
 * Override via APOLLO_RATE_LIMIT_PER_HOUR env var for bulk seed runs
 * on larger plans (Cole's MPI / FSIS / known_entities backfills land
 * here). Apollo's published per-endpoint cap is 600/hr on most plans;
 * higher caps exist on Enterprise. Set this conservatively below your
 * actual plan limit.
 *
 * Read lazily — the actual rate-limiter calls this on every check so
 * CLI scripts that load dotenv AFTER `@procur/apollo` is imported still
 * get their overrides honored.
 */
export function getApolloRateLimitPerHour(): number {
  const raw = process.env.APOLLO_RATE_LIMIT_PER_HOUR;
  if (!raw) return 500;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 500;
}

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
