/**
 * @procur/apollo — Apollo.io organization + people enrichment +
 * discovery.
 *
 * Day 1 (PR #393, merged): schema + types + credit-log + rate limiter.
 * Day 1.5 + Day 2 (this PR): people-side types + org-side HTTP
 * transport (enrichOrgFromApollo, enrichOrgsBatch, searchOrgs).
 * Day 3+ (future PRs): people-side HTTP transport, cron, surfaces,
 * chat tools.
 *
 * APOLLO_ENABLED defaults to false; importing this package is safe
 * even without credentials. Set the env var + APOLLO_MASTER_API_KEY
 * to enable live calls.
 */

export {
  APOLLO_BASE_URL,
  APOLLO_RATE_LIMIT_PER_HOUR,
  APOLLO_BATCH_DOMAINS_PER_CALL,
  APOLLO_BATCH_FRESHNESS_DAYS,
  APOLLO_SINGLE_GET_FRESHNESS_DAYS,
  APOLLO_ENDPOINT_GET_ORG,
  APOLLO_ENDPOINT_SEARCH,
  loadApolloConfig,
  type ApolloConfig,
  type ApolloEndpoint,
} from './config';

export {
  ApolloRateLimiter,
  sharedRateLimiter,
} from './rate-limiter';

export {
  logApolloCall,
  describeApolloCallArgs,
  type LogApolloCallArgs,
} from './credit-log';

export {
  apolloFetch,
  type ApolloFetchResult,
  type ApolloFetchSuccess,
} from './transport';

export {
  enrichOrgFromApollo,
  enrichOrgsBatch,
  searchOrgs,
  type EnrichOrgTarget,
  type EnrichOrgFromApolloArgs,
  type EnrichOrgFromApolloResult,
  type EnrichOrgsBatchArgs,
  type EnrichOrgsBatchResult,
  type SearchOrgsOpts,
} from './org-service';

export {
  APOLLO_SENIORITIES,
  APOLLO_EMAIL_STATUSES,
  type ApolloSeniority,
  type ApolloEmailStatus,
} from './types';

export type {
  ApolloOrgFull,
  ApolloOrgThin,
  ApolloFundingEvent,
  ApolloTechnology,
  ApolloEmployeeMetric,
  ApolloOrgSnapshot,
  ApolloSearchFilters,
  ApolloSearchResult,
  ApolloPersonThin,
  ApolloPersonFull,
  ApolloPeopleSearchFilters,
  ApolloPeopleSearchResult,
  ApolloPersonEnrichmentResult,
  ApolloDegradeReason,
  ApolloDegradeResult,
} from './types';
